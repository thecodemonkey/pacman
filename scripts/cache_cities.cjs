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

function fetchOverpassQuery(query) {
  return new Promise((resolve, reject) => {
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Failed with status ${res.statusCode}`));
      }
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (e) {
          reject(new Error("Failed to parse JSON response"));
        }
      });
    }).on('error', reject);
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

    if (!fs.existsSync(file)) {
      console.log(`Skipping ${city.name}, no existing street cache to append to.`);
      continue;
    }

    const currentFileRaw = fs.readFileSync(file, 'utf-8');
    let currentData;
    try {
        currentData = JSON.parse(currentFileRaw);
    } catch(e) {
        console.error(`Failed to parse ${file}, skipping.`);
        continue;
    }

    if (currentData.data && currentData.gastroData !== undefined) {
      console.log(`Skipping ${city.name}, cache already has gastro data.`);
      continue;
    }

    const gastroRadius = 500;
    const gastroQuery = `[out:json][timeout:25];
      (
        node["amenity"~"^(restaurant|fast_food|cafe)$"](around:${gastroRadius},${city.lat},${city.lon});
        node["shop"="kiosk"](around:${gastroRadius},${city.lat},${city.lon});
        node["cuisine"~"^(pizza|doner|kebab|asian|chinese|vietnamese|thai|japanese|sushi|noodle)$"](around:${gastroRadius},${city.lat},${city.lon});
        way["amenity"~"^(restaurant|fast_food|cafe)$"](around:${gastroRadius},${city.lat},${city.lon});
        way["shop"="kiosk"](around:${gastroRadius},${city.lat},${city.lon});
        way["cuisine"~"^(pizza|doner|kebab|asian|chinese|vietnamese|thai|japanese|sushi|noodle)$"](around:${gastroRadius},${city.lat},${city.lon});
        relation["amenity"~"^(restaurant|fast_food|cafe)$"](around:${gastroRadius},${city.lat},${city.lon});
        relation["shop"="kiosk"](around:${gastroRadius},${city.lat},${city.lon});
        relation["cuisine"~"^(pizza|doner|kebab|asian|chinese|vietnamese|thai|japanese|sushi|noodle)$"](around:${gastroRadius},${city.lat},${city.lon});
      );
      out center;`;

    console.log(`Fetching gastronomy data for ${city.name} (${city.lat}, ${city.lon})...`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const gastroData = await fetchOverpassQuery(gastroQuery);

        const combinedData = { data: currentData, gastroData };
        fs.writeFileSync(file, JSON.stringify(combinedData));
        
        console.log(`Saved merged data to ${file}`);
        await delay(3000); // Backoff before next city
        break; // Success, break retry loop
      } catch(err) {
        console.error(`Attempt ${attempt} failed to fetch ${city.name} gastro data: ${err.message}.`);
        if (attempt < 3) {
          console.log(`Retrying in 5s...`);
          await delay(5000); // Backoff and retry
        } else {
          console.error(`Giving up on ${city.name} gastro data after 3 attempts.`);
        }
      }
    }
  }
}

fetchAll();
