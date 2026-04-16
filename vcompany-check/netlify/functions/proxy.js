// netlify/functions/proxy.js
// Serverloze proxy — draait op Netlify's servers, geen CORS-probleem

const https = require('https');

const VCOMPANY_HOST = 'www.vcompany.nl';

// Sessie-cookie wordt bewaard tussen requests via module-level cache
let sessionCookie = '';

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      // Vang Set-Cookie op om sessie te bewaren
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        const cookies = setCookie.map(c => c.split(';')[0]).join('; ');
        if (cookies) sessionCookie = cookies;
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let params;
  try { params = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cartId, startDate, endDate } = params;
  if (!cartId || !startDate || !endDate) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing params: cartId, startDate, endDate' }) };
  }

  const commonHeaders = {
    'Host': VCOMPANY_HOST,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'nl-NL,nl;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': sessionCookie,
  };

  try {
    // Stap 1: product toevoegen aan winkelwagen
    await request({
      hostname: VCOMPANY_HOST,
      path: `/shoppingcart/addtocart/${cartId}`,
      method: 'POST',
      headers: { ...commonHeaders, 'Content-Length': 0 },
    });

    // Stap 2: datum instellen + beschikbaarheid ophalen
    const postBody = `startDate=${startDate}&endDate=${endDate}&startTime=07%3A00&endTime=20%3A00`;
    const changeRes = await request({
      hostname: VCOMPANY_HOST,
      path: '/ShoppingCart/ChangeDate',
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
      },
    }, postBody);

    // Stap 3: product verwijderen
    await request({
      hostname: VCOMPANY_HOST,
      path: `/ShoppingCart/RemoveProduct/${cartId}`,
      method: 'POST',
      headers: { ...commonHeaders, 'Content-Length': 0 },
    });

    // Stap 4: parse beschikbaarheid uit HTML
    let available = null;
    try {
      const arr = JSON.parse(changeRes.body);
      const html = arr[0] || '';
      // Zoek .AlternativeProduct.circle — title gevuld = beschikbaar, leeg = bezet
      const match = html.match(/class=\\"AlternativeProduct circle\\" title=\\"([^\\"]*)\\"/);
      if (match !== null) available = match[1].length > 0;
    } catch (e) { available = null; }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ cartId, available }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
