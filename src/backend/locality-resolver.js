const fs = require('fs');
const path = require('path');

const CELL_SIZE = 0.5;
const EARTH_RADIUS_M = 6_371_000;
const buckets = new Map();

function key(lat, lon) { return `${Math.floor(lat / CELL_SIZE)}:${Math.floor(lon / CELL_SIZE)}`; }
function distanceMeters(latA, lonA, latB, lonB) {
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(latB - latA); const dLon = radians(lonB - lonA);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

try {
  const source = fs.readFileSync(path.join(__dirname, 'localities', 'europe.json'), 'utf8').replace(/^\uFEFF/, '');
  const places = JSON.parse(source);
  for (const place of places) { const bucketKey = key(place.lat, place.lon); const bucket = buckets.get(bucketKey) || []; bucket.push(place); buckets.set(bucketKey, bucket); }
  console.log(`Loaded ${places.length} European localities for OBS labels`);
} catch (error) { console.warn(`Locality labels unavailable: ${error.message}`); }

function resolveLocality(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !buckets.size) return null;
  const latCell = Math.floor(latitude / CELL_SIZE); const lonCell = Math.floor(longitude / CELL_SIZE);
  let closest = null;
  for (let latOffset = -1; latOffset <= 1; latOffset += 1) for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
    for (const place of buckets.get(`${latCell + latOffset}:${lonCell + lonOffset}`) || []) {
      const distance = distanceMeters(latitude, longitude, place.lat, place.lon);
      if (!closest || distance < closest.distance) closest = { ...place, distance };
    }
  }
  return closest && closest.distance <= 30_000 ? closest.name : null;
}

module.exports = { resolveLocality };
