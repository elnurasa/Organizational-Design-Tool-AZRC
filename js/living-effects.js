/**
 * living-effects.js
 * ---------------------------------------------------------------------------
 * Purely visual: draws the slow "node network" (echoing the dots and lines of
 * the Azerconnect mark) behind the header band / sign-in page, and tracks the
 * cursor for the card spotlight in css/living.css. It reads and changes no
 * application data, and does nothing for users who prefer reduced motion
 * beyond drawing one still frame.
 * ---------------------------------------------------------------------------
 */
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isLogin = document.body.classList.contains("login-page");
  const dpr = window.devicePixelRatio || 1;

  const canvas = document.createElement("canvas");
  canvas.className = "living-net";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let w = 0;
  let h = 0;
  let nodes = [];
  const mouse = { x: -999, y: -999 };
  let running = false;
  // Drives the dtFactor below — without it, node movement is a fixed amount
  // per frame, which runs visibly faster on a high refresh-rate display (twice
  // as fast at 120Hz as at 60Hz) and can briefly race after the browser drops
  // frames (a background tab, a GC pause). null means "no reference yet", so
  // the very first frame after (re)starting never computes a stray jump.
  let lastTimestamp = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    w = canvas.width = Math.max(1, rect.width * dpr);
    h = canvas.height = Math.max(1, rect.height * dpr);
    const count = Math.min(90, Math.round((rect.width * rect.height) / 14000));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.35 * dpr,
      vy: (Math.random() - 0.5) * 0.35 * dpr,
      r: (1.2 + Math.random() * 1.8) * dpr,
    }));
  }

  function frame(timestamp) {
    const reach = 140 * dpr;
    ctx.clearRect(0, 0, w, h);

    // Normalize movement to a 60fps baseline (the speed every value above was
    // tuned against) instead of one fixed step per frame, and cap it at 4x a
    // normal frame's worth so a long gap between frames produces one slightly
    // larger step, never a sudden burst of fast motion.
    let dtFactor = 1;
    if (!reduce && typeof timestamp === "number") {
      if (lastTimestamp !== null) {
        dtFactor = Math.min(Math.max((timestamp - lastTimestamp) / (1000 / 60), 0), 4);
      }
      lastTimestamp = timestamp;
    }

    for (const n of nodes) {
      if (!reduce) {
        n.x += n.vx * dtFactor;
        n.y += n.vy * dtFactor;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
      }
      const dm = Math.hypot(n.x - mouse.x, n.y - mouse.y);
      if (dm < reach * 1.2) {
        n.x += (n.x - mouse.x) * 0.002 * dtFactor;
        n.y += (n.y - mouse.y) * 0.002 * dtFactor;
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = dm < reach ? "rgba(168,240,180,.95)" : "rgba(255,255,255,.45)";
      ctx.fill();
    }

    ctx.lineWidth = dpr;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < reach) {
          const near = Math.hypot((a.x + b.x) / 2 - mouse.x, (a.y + b.y) / 2 - mouse.y) < reach;
          ctx.strokeStyle = near ? `rgba(168,240,180,${0.7 * (1 - d / reach)})` : `rgba(255,255,255,${0.16 * (1 - d / reach)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    if (!reduce && running) requestAnimationFrame(frame);
  }

  function start() {
    if (reduce || running) {
      if (reduce) frame();
      return;
    }
    running = true;
    lastTimestamp = null;
    requestAnimationFrame(frame);
  }

  resize();
  frame();
  start();
  window.addEventListener("resize", () => {
    resize();
    if (reduce) frame();
  });
  document.addEventListener("visibilitychange", () => {
    running = false;
    if (!document.hidden) start();
  });

  // The band sits at the top of the page; the sign-in canvas covers the screen.
  document.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = (event.clientX - rect.left) * dpr;
    mouse.y = (event.clientY - rect.top) * dpr;

    const card = event.target.closest && event.target.closest(".category-card, .review-answer-card");
    if (card) {
      const box = card.getBoundingClientRect();
      card.style.setProperty("--x", event.clientX - box.left + "px");
      card.style.setProperty("--y", event.clientY - box.top + "px");
    }
  });
  document.addEventListener("mouseleave", () => {
    mouse.x = mouse.y = -999;
  });
})();
