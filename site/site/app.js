/* QuickyWiki site interactions */
(() => {
  "use strict";
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── Hero headline: word-by-word entrance ── */
  const title = $("#heroTitle");
  if (title && !reduceMotion) {
    const splitWords = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.append(part); return; }
            const w = document.createElement("span");
            w.className = "w";
            w.textContent = part;
            frag.append(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          splitWords(child);
        }
      });
    };
    splitWords(title);
    $$(".w", title).forEach((w, i) => w.style.setProperty("--wd", `${0.08 * i + 0.1}s`));
  }

  /* ── Scroll reveals ── */
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }),
    { threshold: 0.12, rootMargin: "0px 0px -40px" }
  );
  $$(".reveal").forEach((el) => io.observe(el));

  /* ── Nav: solid on scroll + mobile sheet ── */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("is-solid", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const burger = $("#burger");
  burger.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", open);
  });
  $$(".nav__sheet a").forEach((a) =>
    a.addEventListener("click", () => nav.classList.remove("is-open"))
  );

  /* ── Phone tilt on pointer ── */
  if (!reduceMotion && matchMedia("(pointer: fine)").matches) {
    $$("[data-tilt]").forEach((el) => {
      el.addEventListener("mousemove", (e) => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(900px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg)`;
      });
      el.addEventListener("mouseleave", () => (el.style.transform = ""));
    });
  }

  /* ── Stat counters ── */
  const counters = $$("[data-count]");
  const cio = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      cio.unobserve(e.target);
      const el = e.target;
      const target = +el.dataset.count;
      const suffix = el.dataset.suffix || "";
      const t0 = performance.now();
      const dur = 1400;
      const tick = (t) => {
        const p = Math.min((t - t0) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      reduceMotion ? (el.textContent = target + suffix) : requestAnimationFrame(tick);
    });
  }, { threshold: 0.6 });
  counters.forEach((el) => cio.observe(el));

  /* ── Waitlist forms (front-end only) ── */
  $$("form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("input[type=email]", form);
      if (!input.value || !input.checkValidity()) { input.focus(); return; }
      // TODO: POST to your waitlist provider here.
      input.value = "";
      $(".form__ok", form).hidden = false;
    });
  });

  /* ════════════════════════════════════
     INTERACTIVE READER
     ════════════════════════════════════ */
  const reader = $("#qwReader");
  if (!reader) return;

  const pages = $$(".rpage", reader);
  const dotsBox = $("#rDots");
  const count = $("#rCount");
  const fill = $("#rProgress");
  const prevBtn = $("#rPrev");
  const nextBtn = $("#rNext");
  const stage = $("#rStage");
  const tip = $("#rTip");
  let cur = 0;

  pages.forEach((_, i) => {
    const d = document.createElement("i");
    if (i === 0) d.classList.add("is-on");
    d.addEventListener("click", () => go(i));
    dotsBox.append(d);
  });
  const dots = $$("i", dotsBox);

  function go(n) {
    if (n < 0 || n >= pages.length || n === cur) return;
    hideTip();
    const dir = n > cur ? 1 : -1;
    // park every page on the side it belongs to, relative to the new page
    pages.forEach((p, i) => {
      p.classList.remove("is-current");
      p.classList.toggle("is-prev", i < n);
    });
    // incoming page starts on the side it travels from, then slides in
    pages[n].classList.toggle("is-prev", dir < 0);
    void pages[n].offsetWidth; // flush styles so the transition starts from the parked side
    pages[n].classList.remove("is-prev");
    pages[n].classList.add("is-current");
    cur = n;
    dots.forEach((d, i) => d.classList.toggle("is-on", i === cur));
    count.textContent = `${cur + 1} of ${pages.length}`;
    fill.style.width = `${((cur + 1) / pages.length) * 100}%`;
    prevBtn.disabled = cur === 0;
    nextBtn.disabled = cur === pages.length - 1;
    pages[cur].scrollTop = 0;
  }

  prevBtn.addEventListener("click", () => go(cur - 1));
  nextBtn.addEventListener("click", () => go(cur + 1));
  $("#rRestart").addEventListener("click", () => go(0));
  prevBtn.disabled = true;

  /* keyboard — only when reader is on screen */
  let readerVisible = false;
  new IntersectionObserver(
    ([e]) => (readerVisible = e.isIntersecting),
    { threshold: 0.6 } // only capture arrow keys when the phone is mostly on screen
  ).observe(reader);
  addEventListener("keydown", (e) => {
    if (!readerVisible || e.target.matches("input, textarea")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") { go(cur + 1); e.preventDefault(); }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") { go(cur - 1); e.preventDefault(); }
  });

  /* vertical touch swipe — only turns the page when the text is at its scroll edge */
  let sx = null, sy = null;
  stage.addEventListener("touchstart", (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (sy === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const page = pages[cur];
    const atTop = page.scrollTop <= 2;
    const atBottom = page.scrollTop + page.clientHeight >= page.scrollHeight - 2;
    if (Math.abs(dy) > 55 && Math.abs(dy) > Math.abs(dx) * 1.4) {
      if (dy < 0 && atBottom) go(cur + 1);      // swipe up → next page
      else if (dy > 0 && atTop) go(cur - 1);    // swipe down → previous page
    }
    sx = sy = null;
  }, { passive: true });

  /* theme / font / size controls */
  $$("[data-rtheme]", reader).forEach((b) =>
    b.addEventListener("click", () => {
      reader.dataset.theme = b.dataset.rtheme;
      $$("[data-rtheme]", reader).forEach((x) => x.classList.toggle("is-on", x === b));
    })
  );
  $$("[data-rfont]", reader).forEach((b) =>
    b.addEventListener("click", () => {
      reader.dataset.font = b.dataset.rfont;
      $$("[data-rfont]", reader).forEach((x) => x.classList.toggle("is-on", x === b));
    })
  );
  $$("[data-rsize]", reader).forEach((b) =>
    b.addEventListener("click", () => {
      const next = Math.min(3, Math.max(1, +reader.dataset.size + +b.dataset.rsize));
      reader.dataset.size = next;
    })
  );

  /* jargon tooltips */
  function hideTip() { tip.hidden = true; $$(".jargon.is-active", reader).forEach((j) => j.classList.remove("is-active")); }
  $$(".jargon", reader).forEach((j) => {
    j.addEventListener("click", (e) => {
      e.stopPropagation();
      if (j.classList.contains("is-active")) { hideTip(); return; }
      hideTip();
      j.classList.add("is-active");
      $("p", tip).textContent = j.dataset.def;
      tip.hidden = false;
      const rRect = $("#rScreen").getBoundingClientRect();
      const jRect = j.getBoundingClientRect();
      const tipW = Math.min(250, rRect.width - 28);
      tip.style.maxWidth = tipW + "px";
      let left = jRect.left - rRect.left;
      left = Math.max(12, Math.min(left, rRect.width - tipW - 12));
      tip.style.left = left + "px";
      tip.style.top = jRect.top - rRect.top - tip.offsetHeight - 10 + "px";
      const tail = $(".reader__tipTail", tip);
      tail.style.left = Math.max(14, jRect.left - rRect.left - left + 6) + "px";
    });
  });
  document.addEventListener("click", (e) => {
    if (!tip.hidden && !e.target.closest(".jargon")) hideTip();
  });
})();
