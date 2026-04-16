const https = require('https');

const HOST = 'www.vcompany.nl';

function req(options, postData) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({
        status: res.statusCode,
        body,
        headers: res.headers,
        location: res.headers['location'] || null,
        cookies: res.headers['set-cookie'] || [],
      }));
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

// Volg redirects en verzamel cookies
async function get(path, cookie) {
  let currentPath = path;
  for (let i = 0; i < 5; i++) {
    const res = await req({
      hostname: HOST,
      path: currentPath,
      method: 'GET',
      headers: {
        'Host': HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cookie': cookie,
      }
    });
    // Merge new cookies
    if (res.cookies.length) {
      const map = {};
      cookie.split('; ').filter(Boolean).forEach(c => { const i = c.indexOf('='); if (i>0) map[c.substring(0,i).trim()] = c.substring(i+1); });
      res.cookies.forEach(c => { const part = c.split(';')[0]; const i = part.indexOf('='); if (i>0) map[part.substring(0,i).trim()] = part.substring(i+1); });
      cookie = Object.entries(map).map(([k,v]) => `${k}=${v}`).join('; ');
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      currentPath = res.location.startsWith('http') ? new URL(res.location).pathname : res.location;
      continue;
    }
    return { res, cookie };
  }
  throw new Error('Too many redirects');
}

async function post(path, body, cookie, extraHeaders = {}) {
  const res = await req({
    hostname: HOST,
    path,
    method: 'POST',
    headers: {
      'Host': HOST,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'nl-NL,nl;q=0.9',
      'Accept-Encoding': 'identity',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${HOST}/shoppingcart/shopcart`,
      'Origin': `https://${HOST}`,
      'Connection': 'keep-alive',
      'Cookie': cookie,
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
    }
  }, body);

  if (res.cookies.length) {
    const map = {};
    cookie.split('; ').filter(Boolean).forEach(c => { const i = c.indexOf('='); if (i>0) map[c.substring(0,i).trim()] = c.substring(i+1); });
    res.cookies.forEach(c => { const part = c.split(';')[0]; const i = part.indexOf('='); if (i>0) map[part.substring(0,i).trim()] = part.substring(i+1); });
    cookie = Object.entries(map).map(([k,v]) => `${k}=${v}`).join('; ');
  }
  return { res, cookie };
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

  try {
    let cookie = '';

    // Stap 1: bezoek homepage — sessie opbouwen
    const home = await get('/', cookie);
    cookie = home.cookie;

    // Stap 2: bezoek winkelwagen pagina
    const cart = await get('/shoppingcart/shopcart', cookie);
    cookie = cart.cookie;

    // Stap 3: voeg product toe
    const add = await post(`/shoppingcart/addtocart/${cartId}`, '', cookie);
    cookie = add.cookie;

    // Stap 4: verander datum
    const dateBody = `startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&startTime=07%3A00&endTime=20%3A00`;
    const change = await post('/ShoppingCart/ChangeDate', dateBody, cookie);
    cookie = change.cookie;

    // Stap 5: verwijder product
    await post(`/ShoppingCart/RemoveProduct/${cartId}`, '', cookie);

    // Stap 6: parse beschikbaarheid
    const rawBody = change.res.body;
    let available = null;

    try {
      // Response is JSON array: ["<html...>"]
      const arr = JSON.parse(rawBody);
      const html = Array.isArray(arr) ? (arr[0] || '') : rawBody;

      // Zoek het AlternativeProduct circle element
      // In JSON-gecodeerde HTML zijn < en > unicode-escaped als \u003c en \u003e
      // title gevuld = beschikbaar, title leeg = niet beschikbaar
      const patterns = [
        /class=\\"AlternativeProduct circle\\" title=\\"([^\\"]*)\\"/,  // JSON escaped
        /class="AlternativeProduct circle" title="([^"]*)"/,             // plain HTML
      ];

      for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m !== null) {
          available = m[1].trim().length > 0;
          break;
        }
      }

      // Fallback: zoek op beschikbaar/niet beschikbaar tekst
      if (available === null) {
        if (/niet beschikbaar/i.test(html)) available = false;
        else if (/beschikbaar/i.test(html)) available = true;
      }

    } catch (e) {
      // Geen JSON — probeer direct
      const m = rawBody.match(/class="AlternativeProduct circle" title="([^"]*)"/);
      if (m) available = m[1].trim().length > 0;
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        cartId,
        available,
        // Stuur debug info mee als null zodat we kunnen debuggen
        ...(available === null && { debug: rawBody.substring(0, 300) })
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
