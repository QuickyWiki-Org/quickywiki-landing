using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

// Downloads each Quicky's cover from public blob storage and saves a web-sized copy for the site.
//
//   dotnet run --project _build/covers -- <quickies.json | folder of json files> [outDir]
//
// Blob names follow SummaryMapper.ToBlobSlug(title) in the backend, but older uploads kept
// punctuation ("olympus-mons:-the-volcano-that-dwarfs-everest.webp"), so the container listing is
// read and matched on the slug. Quickies without a cover are skipped; files that already exist in
// outDir are not downloaded again.

const string BlobBase = "https://quickywikistorage.blob.core.windows.net/images/";
const string ListUrl = BlobBase + "?restype=container&comp=list&maxresults=5000";
const int Size = 640;
const int Quality = 72;

var input = args.Length > 0 ? args[0] : "_build/quickies.json";
var outDir = args.Length > 1 ? args[1] : "assets/covers/q";
Directory.CreateDirectory(outDir);

var files = Directory.Exists(input)
    ? Directory.GetFiles(input, "*.json").OrderBy(f => f, StringComparer.Ordinal).ToArray()
    : [input];
var titles = files
    .SelectMany(f =>
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(f));
        var items = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().ToList() : [doc.RootElement];
        return items
            .Where(e => e.ValueKind == JsonValueKind.Object && e.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String)
            .Select(e => e.GetProperty("title").GetString()!)
            .ToList();
    })
    .Select(ToBlobSlug)
    .Where(s => s.Length > 0)
    .Distinct()
    .ToList();

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };

// slug -> actual blob name; an exact ToBlobSlug name wins over a punctuated legacy one.
var blobs = new Dictionary<string, string>();
var marker = "";
do
{
    var xml = System.Xml.Linq.XDocument.Parse(await http.GetStringAsync(ListUrl + (marker.Length > 0 ? $"&marker={Uri.EscapeDataString(marker)}" : "")));
    foreach (var name in xml.Descendants("Blob").Select(b => (string)b.Element("Name")!))
    {
        if (!name.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)) continue;
        var slug = ToBlobSlug(name[..^5]);
        if (!blobs.ContainsKey(slug) || name[..^5] == slug) blobs[slug] = name;
    }
    marker = (string?)xml.Root!.Element("NextMarker") ?? "";
} while (marker.Length > 0);

// Covers uploaded under a name unrelated to the title (prompt-named uploads, or a sibling Quicky
// on the same subject). Checked by eye; add entries here rather than renaming blobs.
var overrides = new Dictionary<string, string>
{
    ["docker-software"] = "containerization.webp",
    ["the-garden-of-earthly-delights"] = "a-whimsical-surreal-medieval-garden-with-giant-colorful-fruit-fantastical-hybrid-creatures-and-dreamlike-rock-formations-triptych-painting-style-no-people.webp",
    ["hedy-lamarr-the-movie-star-who-helped-invent-wi-fi"] = "hedy-lamarr.webp",
    ["the-ancient-olympic-games-naked-sprints-and-a-sacred-truce"] = "olympic-games.webp",
};
foreach (var (slug, name) in overrides)
    blobs.TryAdd(slug, name);
var encoder = new WebpEncoder { Quality = Quality, FileFormat = WebpFileFormatType.Lossy };
var saved = 0; var skipped = 0; var missing = new ConcurrentBag<string>(); var failed = new ConcurrentBag<string>();

await Parallel.ForEachAsync(titles, new ParallelOptions { MaxDegreeOfParallelism = 8 }, async (slug, ct) =>
{
    var target = Path.Combine(outDir, $"{slug}.webp");
    if (File.Exists(target)) { Interlocked.Increment(ref skipped); return; }
    try
    {
        if (!blobs.TryGetValue(slug, out var blobName)) { missing.Add(slug); return; }
        using var response = await http.GetAsync(BlobBase + Uri.EscapeDataString(blobName), ct);
        if (response.StatusCode == HttpStatusCode.NotFound) { missing.Add(slug); return; }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var image = await Image.LoadAsync(stream, ct);
        image.Mutate(x => x.Resize(new ResizeOptions { Size = new Size(Size, Size), Mode = ResizeMode.Max }));
        await image.SaveAsWebpAsync(target, encoder, ct);
        Interlocked.Increment(ref saved);
    }
    catch (Exception ex)
    {
        failed.Add($"{slug}: {ex.Message}");
    }
});

Console.WriteLine($"{titles.Count} Quickies: {saved} covers saved, {skipped} already present, {missing.Count} without a cover, {failed.Count} failed.");
foreach (var f in failed) Console.WriteLine($"  failed  {f}");
foreach (var m in missing.Order()) Console.WriteLine($"  missing {m}");

// Mirrors QuickyWiki's SummaryMapper.ToBlobSlug.
static string ToBlobSlug(string title)
{
    var lowered = title.Trim().ToLowerInvariant().Replace(' ', '-');
    return new string(lowered.Where(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-').ToArray()).Trim('-');
}
