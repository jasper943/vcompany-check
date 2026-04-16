const https = require('https');
const HOST = 'www.vcompany.nl';

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({
        status: res.statusCode,
        body,
        headers: res.headers,
        location: res.headers['location'] || null,
        rawCookies: res.headers['set-cookie'] || [],
      }));
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

function mergeCookies(existing, newRaw) {
  const map = {};
  existing.split('; ').filter(Boolean).forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) map[c.substring(0, i).trim()] = c.substring(i + 1);
  });
  newRaw.forEach(c => {
    const part = c.split(';')[0];
    const i = part.indexOf('=');
    if (i > 0) map[part.substring(0, i).trim()] = part.substring(i + 1);
  });
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

const BASE_HEADERS = {
  'Host': HOST,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'nl-NL,nl;q=0.9',
  'Accept-Encoding': 'identity',
  'Connection': 'keep-alive',
};

async function getPage(path, cookie) {
  let current = path;
  for (let i = 0; i < 6; i++) {
    const res = await makeRequest({
      hostname: HOST, path: current, method: 'GET',
      headers: { ...BASE_HEADERS, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Cookie': cookie }
    });
    if (res.rawCookies.length) cookie = mergeCookies(cookie, res.rawCookies);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = res.location.startsWith('http') ? new URL(res.location).pathname + (new URL(res.location).search || '') : res.location;
      continue;
    }
    return { res, cookie };
  }
  throw new Error('Too many redirects on ' + path);
}

async function postReq(path, body, cookie) {
  const res = await makeRequest({
    hostname: HOST, path, method: 'POST',
    headers: {
      ...BASE_HEADERS,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${HOST}/shoppingcart/shopcart`,
      'Origin': `https://${HOST}`,
      'Cookie': cookie,
      'Content-Length': Buffer.byteLength(body || ''),
    }
  }, body || '');
  if (res.rawCookies.length) cookie = mergeCookies(cookie, res.rawCookies);
  return { res, cookie };
}

function parseAvailability(rawBody) {
  let html = rawBody;

  // Probeer JSON array te parsen (response is ["<html>..."])
  try {
    const parsed = JSON.parse(rawBody);
    html = Array.isArray(parsed) ? (parsed[0] || '') : (typeof parsed === 'string' ? parsed : rawBody);
  } catch (e) { /* geen JSON, gebruik rawBody direct */ }

  // Decodeer unicode escapes (\u003c → <)
  try { html = JSON.parse('"' + html.replace(/"/g, '\\"').replace(/\\"/g, '"') + '"'); } catch (e) {}

  // Zoek het bolletje: class="AlternativeProduct circle" title="..."
  // title GEVULD = beschikbaar (groen), title LEEG = niet beschikbaar (rood)
  const patterns = [
    /"AlternativeProduct circle" title="([^"]*)"/g,
    /AlternativeProduct circle\\" title=\\"([^\\"]*)\\"/g,
    /class="AlternativeProduct circle"[^>]*title="([^"]*)"/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const m = pattern.exec(html);
    if (m !== null) {
      // title gevuld = beschikbaar, leeg = niet beschikbaar
      return m[1].trim().length > 0;
    }
  }

  // Fallback op tekst
  if (/niet beschikbaar/i.test(html)) return false;
  if (/\bbeschikbaar\b/i.test(html)) return true;

  return null; // onbekend
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  let params;
  try { params = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cartId, startDate, endDate } = params;
  if (!cartId || !startDate || !endDate) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing params' }) };
  }

  // Blokkeer vandaag — site staat dit niet toe
  const [d, m, y] = startDate.split('-').map(Number);
  const reqDate = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (reqDate <= today) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ cartId, available: false, reason: 'today_or_past' }) };
  }

  try {
    let cookie = '';

    // Stap 1+2 parallel: homepage EN winkelwagen tegelijk voor snelheid
    // Eerst homepage voor cookie, dan direct winkelwagen
    const home = await getPage('/', cookie);
    cookie = home.cookie;
    // Winkelwagen en addtocart parallel zodra we cookie hebben
    const [cartPage, ] = await Promise.all([
      getPage('/shoppingcart/shopcart', cookie),
      Promise.resolve(), // placeholder
    ]);
    cookie = cartPage.cookie;

    // Stap 3: voeg ALLEEN dit product toe (winkelwagen was leeg door verse sessie)
    const add = await postReq(`/shoppingcart/addtocart/${cartId}`, '', cookie);
    cookie = add.cookie;

    // Stap 4: stel datum in — triggert beschikbaarheidscheck
    const dateBody = `startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&startTime=07%3A00&endTime=20%3A00`;
    const change = await postReq('/ShoppingCart/ChangeDate', dateBody, cookie);
    cookie = change.cookie;

    // Stap 5: verwijder product (netjes opruimen)
    await postReq(`/ShoppingCart/RemoveProduct/${cartId}`, '', cookie);

    // Stap 6: parse de beschikbaarheid
    const available = parseAvailability(change.res.body);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        cartId,
        available,
        ...(available === null && { debug: change.res.body.substring(0, 400) })
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
