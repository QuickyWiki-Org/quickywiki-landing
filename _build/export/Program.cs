using Azure.Identity;
using Microsoft.Azure.Cosmos;
using Newtonsoft.Json.Linq;

// Read-only export of published, curated English Quickies for the static /quickies/ section.
//
//   dotnet run --project _build/export -- _build/quickies.json [maxCount]   (default: all)
//
// Auth: COSMOS_READONLY_KEY (the account's *read-only* key) if set, otherwise Microsoft Entra ID
// via `az login` (needs the Cosmos DB Built-in Data Reader role in the prod tenant).
// Never pass a read-write key; this tool only ever queries.

const string Endpoint = "https://quickywiki-prod-cdb.documents.azure.com:443/";
const string TenantId = "7fbac2b1-53ce-407c-8c43-29297c6809af";

var output = args.Length > 0 ? args[0] : "_build/quickies.json";
var take = args.Length > 1 ? int.Parse(args[1]) : int.MaxValue;
var options = new CosmosClientOptions { ConnectionMode = ConnectionMode.Gateway };
var key = Environment.GetEnvironmentVariable("COSMOS_READONLY_KEY");
using var client = string.IsNullOrWhiteSpace(key)
    ? new CosmosClient(Endpoint, new AzureCliCredential(new AzureCliCredentialOptions { TenantId = TenantId }), options)
    : new CosmosClient(Endpoint, key, options);

var container = client.GetContainer("quickywiki-db", "summaries");
var query = new QueryDefinition("""
    SELECT TOP @take c.id, c.title, c.description, c.sections, c.coverImageUrl, c.categories, c.facts, c.jargons,
           c.pageUrl, c.articleUrl, c.publicationDate, c.contentUpdatedAt, c.modificationDate, c.likesCount
    FROM c
    WHERE c.discriminator = 'Summary' AND c.status = 'Public' AND c.origin = 'System'
      AND c.languageCode = 'en' AND IS_STRING(c.coverImageUrl) AND c.coverImageUrl != ''
      AND ARRAY_LENGTH(c.sections) >= 3
    ORDER BY c.likesCount DESC
    """).WithParameter("@take", take);

var all = new JArray();
using var iterator = container.GetItemQueryIterator<JObject>(query);
while (iterator.HasMoreResults)
    foreach (var doc in await iterator.ReadNextAsync())
        all.Add(doc);

File.WriteAllText(output, all.ToString());
Console.WriteLine($"Exported {all.Count} Quickies to {output}");
