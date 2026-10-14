// Measure painted content in the reserved floating-search corner.
// Runs in the browser; shared by the full crawl and cold fragment checks.
export function cornerHits() {
      const bar = document.querySelector('.portal-bar')
      if (!bar) return ['no .portal-bar']
      const r = bar.getBoundingClientRect(), margin = 12
      const zone = { left: r.left - margin, right: innerWidth, top: 0, bottom: r.bottom + margin }
      const out = []
      const hit = (b) => b.width && b.height && b.right > zone.left && b.left < zone.right && b.top < zone.bottom && b.bottom > zone.top
      // Text: measure the glyphs themselves, not the block that holds them.
      const walk = document.createTreeWalker(document.querySelector('main') ?? document.body, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent.trim() || n.parentElement?.closest('.portal-bar')) continue
        const range = document.createRange(); range.selectNodeContents(n)
        for (const b of range.getClientRects()) if (hit(b)) { out.push(`text "${n.textContent.trim().slice(0, 30)}" in ${n.parentElement?.tagName}`); break }
      }
      // Boxes that paint something: backgrounds, borders, images, controls.
      for (const e of document.querySelectorAll('main *')) {
        if (e.closest('.portal-bar')) continue
        const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const r2 = e.getBoundingClientRect()
        const filled = ['IMG', 'svg', 'INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        if (filled) { if (hit(r2)) out.push(`${e.tagName}.${String(e.className).slice(0, 40)}`); continue }
        // Border-only boxes paint just their edges: test each edge as a thin strip.
        const edges = [
          parseFloat(cs.borderTopWidth) > 0 && { left: r2.left, right: r2.right, top: r2.top, bottom: r2.top + 1, width: r2.width, height: 1 },
          parseFloat(cs.borderBottomWidth) > 0 && { left: r2.left, right: r2.right, top: r2.bottom - 1, bottom: r2.bottom, width: r2.width, height: 1 },
          parseFloat(cs.borderLeftWidth) > 0 && { left: r2.left, right: r2.left + 1, top: r2.top, bottom: r2.bottom, width: 1, height: r2.height },
          parseFloat(cs.borderRightWidth) > 0 && { left: r2.right - 1, right: r2.right, top: r2.top, bottom: r2.bottom, width: 1, height: r2.height },
        ].filter(Boolean)
        if (edges.some(hit)) out.push(`${e.tagName}.${String(e.className).slice(0, 40)} (border)`)
      }
      return out.slice(0, 4)

}
