const https = require('https');

const HOST = 'www.vcompany.nl';

function req(options, postData) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      const cookies = res.headers['set-cookie'];
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, cookies, headers: res.headers }));
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

function parseCookies(cookieArray) {
  if (!cookieArray) return '';
  return cookieArray.map(c => c.split(';')[0]).join('; ');
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };

  let params;
  try { params = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cartId, startDate, endDate } = params;
  if (!cartId || !startDate || !endDate) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing params' }) };
  }

  try {
    // Stap 1: haal de homepage op om een sessie-cookie te krijgen
    const homeRes = await req({
      hostname: HOST,
      path: '/',
      method: 'GET',
      headers: {
        'Host': HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'nl-NL,nl;q=0.9',
      }
    });

    let cookie = parseCookies(homeRes.cookies);

    // Stap 2: product toevoegen aan winkelwagen
    const addRes = await req({
      hostname: HOST,
      path: `/shoppingcart/addtocart/${cartId}`,
      method: 'POST',
      headers: {
        'Host': HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': '*/*',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${HOST}/`,
        'Cookie': cookie,
        'Content-Length': '0',
      }
    });

    if (addRes.cookies) {
      const newCookies = parseCookies(addRes.cookies);
      // Merge cookies
      const cookieMap = {};
      cookie.split('; ').forEach(c => { const [k,v] = c.split('='); if(k) cookieMap[k.trim()] = v; });
      newCookies.split('; ').forEach(c => { const [k,v] = c.split('='); if(k) cookieMap[k.trim()] = v; });
      cookie = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');
    }

    // Stap 3: datum wijzigen — triggert beschikbaarheidscheck
    const postBody = `startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&startTime=07%3A00&endTime=20%3A00`;
    const changeRes = await req({
      hostname: HOST,
      path: '/ShoppingCart/ChangeDate',
      method: 'POST',
      headers: {
        'Host': HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'application/json, text/javascript, */*',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${HOST}/shoppingcart/shopcart`,
        'Cookie': cookie,
        'Content-Length': Buffer.byteLength(postBody),
      }
    }, postBody);

    if (changeRes.cookies) {
      const newCookies = parseCookies(changeRes.cookies);
      const cookieMap = {};
      cookie.split('; ').forEach(c => { const [k,v] = c.split('='); if(k) cookieMap[k.trim()] = v; });
      newCookies.split('; ').forEach(c => { const [k,v] = c.split('='); if(k) cookieMap[k.trim()] = v; });
      cookie = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');
    }

    // Stap 4: product verwijderen
    await req({
      hostname: HOST,
      path: `/ShoppingCart/RemoveProduct/${cartId}`,
      method: 'POST',
      headers: {
        'Host': HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${HOST}/shoppingcart/shopcart`,
        'Cookie': cookie,
        'Content-Length': '0',
      }
    });

    // Stap 5: parse beschikbaarheid
    // Response is een JSON array waarvan het eerste element de cart HTML is
    let available = null;
    const rawBody = changeRes.body;

    try {
      // Probeer JSON array te parsen
      const arr = JSON.parse(rawBody);
      const html = typeof arr === 'string' ? arr : (arr[0] || '');

      // Zoek op AlternativeProduct circle title
      // title gevuld = beschikbaar, title leeg = niet beschikbaar
      const circleMatch = html.match(/class=\\"AlternativeProduct circle\\" title=\\"([^\\"]*)\\"/);
      if (circleMatch !== null) {
        available = circleMatch[1].length > 0;
      } else {
        // Fallback: zoek op span.available of span class met beschikbaar tekst
        const availMatch = html.match(/class=\\"available\\">beschikbaar/);
        const naMatch = html.match(/class=\\"unavailable\\"|niet beschikbaar/i);
        if (availMatch) available = true;
        else if (naMatch) available = false;
      }
    } catch (e) {
      // Body is geen JSON — probeer direct als HTML te parsen
      const circleMatch = rawBody.match(/class="AlternativeProduct circle" title="([^"]*)"/);
      if (circleMatch !== null) {
        available = circleMatch[1].length > 0;
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ cartId, available, debug: available === null ? rawBody.substring(0, 200) : undefined }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
