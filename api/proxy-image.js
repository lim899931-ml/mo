// Many platforms' CDNs (Instagram in particular) don't send CORS headers, so a
// browser <canvas> can't read pixels drawn from that image (a "tainted canvas")
// and compressing/exporting the cover as a data URL silently fails. Fetching the
// bytes here server-side and re-serving them same-origin sidesteps that entirely.

module.exports = async (req, res) => {
  const url = req.query && req.query.url;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'missing url' });
    return;
  }

  let target;
  try {
    target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
  } catch (e) {
    res.status(400).json({ error: 'invalid url' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        Accept: 'image/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!resp.ok) {
      res.status(502).json({ error: 'upstream ' + resp.status });
      return;
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      res.status(415).json({ error: 'not an image' });
      return;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) {
      res.status(413).json({ error: 'too large' });
      return;
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: 'fetch failed' });
  } finally {
    clearTimeout(timer);
  }
};
