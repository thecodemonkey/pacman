const fs = require('fs');
const https = require('https');
const path = require('path');

const cities = [
  { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { name: 'New_York', lat: 40.7128, lon: -74.006 },
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Rio', lat: -22.9068, lon: -43.1729 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Seoul', lat: 37.5665, lon: 126.978 },
  { name: 'Mexico_City', lat: 19.4326, lon: -99.1332 }
];

const publicCitiesDir = path.join(__dirname, '../public/cities');
if (!fs.existsSync(publicCitiesDir)) {
  fs.mkdirSync(publicCitiesDir, { recursive: true });
}

function fetchOverpass(lat, lon, resolve, reject) {
  const radius = 300;
  const query = `
    [out:json];
    (
      way["highway"~"^(primary|secondary|tertiary|residential|service|footway)$"](around:${radius},${lat},${lon});
      way["building"](around:${radius},${lat},${lon});
      node["natural"="tree"](around:${radius},${lat},${lon});
    );
    out body;
    >;
    out skel qt;
  `;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  https.get(url, (res) => {
    if (res.statusCode !== 200) {
      reject(new Error(`Failed with status ${res.statusCode}`));
      res.resume();
      return;
    }
    
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      resolve(rawData);
    });
  }).on('error', (e) => {
    reject(e);
  });
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchAll() {
  for (const city of cities) {
    let latStr = city.lat.toString();
    let lonStr = city.lon.toString();
    const file = path.join(publicCitiesDir, `${latStr}_${lonStr}.json`);

    if (fs.existsSync(file)) {
      console.log(`Skipping ${city.name}, cache already exists.`);
      continue;
    }

    console.log(`Fetching data for ${city.name} (${city.lat}, ${city.lon})...`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const p = new Promise((resolve, reject) => fetchOverpass(city.lat, city.lon, resolve, reject));
        const data = await p;
        fs.writeFileSync(file, data);
        console.log(`Saved ${file}`);
        await delay(5000);
        break; // Sucess, break retry loop
      } catch(err) {
        console.error(`Attempt ${attempt} failed to fetch ${city.name}: ${err.message}.`);
        if (attempt < 3) {
          console.log(`Retrying in 15s...`);
          await delay(15000); // Backoff and retry
        } else {
          console.error(`Giving up on ${city.name} after 3 attempts.`);
        }
      }
    }
  }
}

fetchAll();
