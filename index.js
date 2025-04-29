const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const turf = require('@turf/turf');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const wpNavRTE = JSON.parse(fs.readFileSync('./routes.json', 'utf8'));
const boundaries = JSON.parse(fs.readFileSync('./Boundaries.geojson', 'utf8'));

const zsuBoundary = boundaries.features.find(f => f.properties?.id === 'TJZS');
const zwyBoundary = boundaries.features.find(f => f.properties?.id === 'KZWY');
const ttzpBoundary = boundaries.features.find(f => f.properties?.id === 'TTZP');

const BOUNDARY_FIXES = [
  "KINCH", "HANCY", "CHEDR", "KEEKA", "OPAUL", "SOCCO", "DAWIN",
  "OBIKE", "ANADA", "GEECE", "ILURI", "MODUX", "GABAR", "ZPATA",
  "ELOPO", "LAMKN"
];

let zsuInbound = [];
let zsuOutbound = [];
let userInputs = {};

function isInsideZSU(lat, lon) {
  return turf.booleanPointInPolygon(turf.point([lon, lat]), zsuBoundary);
}
function isInsideZWY(lat, lon) {
  return turf.booleanPointInPolygon(turf.point([lon, lat]), zwyBoundary);
}
function isInsideTTZP(lat, lon) {
  return turf.booleanPointInPolygon(turf.point([lon, lat]), ttzpBoundary);
}
function getCurrentFacility(lat, lon) {
  if (isInsideZWY(lat, lon)) return "ZWY";
  if (isInsideTTZP(lat, lon)) return "TTZP";
  if (isInsideZSU(lat, lon)) return "ZSU";
  return null;
}
function expandRoute(routeString) {
  const parts = routeString.trim().split(/\s+/).map(x => x.split('/')[0].toUpperCase()); // <-- Cleans KINCH/N0485F410
  const expanded = [];

  for (let i = 0; i < parts.length; i++) {
    const current = parts[i];
    const next = parts[i + 1];

    if (wpNavRTE[current]) {
      const airway = current;
      const fromFix = parts[i - 1];
      const toFix = parts[i + 1];
      const airwayFixes = wpNavRTE[airway];
      const fromIndex = airwayFixes.findIndex(f => f.waypoint === fromFix);
      const toIndex = airwayFixes.findIndex(f => f.waypoint === toFix);

      if (fromIndex !== -1 && toIndex !== -1) {
        const slice = fromIndex < toIndex
          ? airwayFixes.slice(fromIndex, toIndex + 1)
          : airwayFixes.slice(toIndex, fromIndex + 1).reverse();

        slice.forEach(fix => {
          if (!expanded.includes(fix.waypoint)) {
            expanded.push(fix.waypoint);
          }
        });
      }
    } else if (!expanded.includes(current)) {
      expanded.push(current);
    }
  }
  return expanded;
}
function getCoordsFromWpNav(fixName) {
  fixName = fixName.toUpperCase();
  for (const airway in wpNavRTE) {
    const fix = wpNavRTE[airway].find(f => f.waypoint === fixName);
    if (fix) return [fix.lon, fix.lat];
  }
  return null;
}
function findNearestWaypoint(lat, lon, expanded) {
  let nearest = null;
  let minDist = Infinity;

  for (const wp of expanded) {
    const coords = getCoordsFromWpNav(wp);
    if (!coords) continue;
    const [lonWp, latWp] = coords;
    const dist = turf.distance(turf.point([lon, lat]), turf.point([lonWp, latWp]), { units: 'nauticalmiles' });
    if (dist < minDist) {
      minDist = dist;
      nearest = wp;
    }
  }
  return nearest;
}
function getRouteDirection(expanded) {
  if (expanded.length < 2) return '';
  const startCoords = getCoordsFromWpNav(expanded[0]);
  const endCoords = getCoordsFromWpNav(expanded[expanded.length - 1]);
  if (!startCoords || !endCoords) return '';

  const dLat = endCoords[1] - startCoords[1];
  const dLon = endCoords[0] - startCoords[0];

  if (Math.abs(dLat) > Math.abs(dLon)) return dLat > 0 ? 'North' : 'South';
  if (Math.abs(dLon) > Math.abs(dLat)) return dLon > 0 ? 'East' : 'West';

  // Default fallback when movement too small
  if (Math.abs(dLat) < 0.1 && Math.abs(dLon) < 0.1) return 'Unknown';
  return dLat > 0 ? 'North' : 'South';
}

function estimateCenterTime(lat, lon, targetFix, groundspeed) {
  const targetCoords = getCoordsFromWpNav(targetFix);
  if (!targetCoords || !groundspeed) return 'N/A';
  const from = turf.point([lon, lat]);
  const to = turf.point(targetCoords);
  const distanceNm = turf.distance(from, to, { units: 'nauticalmiles' });
  const timeHours = distanceNm / groundspeed;
  const eta = new Date(Date.now() + timeHours * 3600 * 1000);
  return eta.toISOString().split('T')[1].slice(0, 5) + 'Z';
}

// === Main Fetch Logic
async function fetchVatsimData() {
  try {
    const res = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
    const { pilots } = res.data;
// // === Inject 4 Real JFK-Caribbean Flights (split 2 ZWY + 2 ZSU) ===
// pilots.push(
//   {
//     cid: 990013,
//     callsign: "TST_JFK_SJU",
//     flight_plan: { route: "CAMRN Y495 SAVIK L459 DARUX L456 THANK A638 PJM", arrival: "TJSJ" },
//     latitude: 24.8, // ZWY (north of ZSU boundary)
//     longitude: -66.5,
//     heading: 180,
//     groundspeed: 450
//   },
//   {
//     cid: 990014,
//     callsign: "TST_JFK_SXM",
//     flight_plan: { route: "CAMRN Y495 SAVIK L459 DARUX L456 THANK A638 PJM A636 STT", arrival: "TNCM" },
//     latitude: 18.7, // ZSU (south of SAVIK)
//     longitude: -63.5,
//     heading: 180,
//     groundspeed: 450
//   },
//   {
//     cid: 990015,
//     callsign: "TST_JFK_BGI",
//     flight_plan: { route: "CAMRN Y495 SAVIK L459 DARUX L456 THANK A638 PJM UA555 ILURI", arrival: "TBPB" },
//     latitude: 18.5, // ZSU (south of SAVIK)
//     longitude: -63.2,
//     heading: 180,
//     groundspeed: 440
//   },
//   {
//     cid: 990016,
//     callsign: "TST_JFK_ANU",
//     flight_plan: { route: "CAMRN Y495 SAVIK L459 DARUX L456 THANK A638 PJM UA552 TAPA", arrival: "TAPA" },
//     latitude: 18.7, // ZSU (south of SAVIK)
//     longitude: -63.5,
//     heading: 180,
//     groundspeed: 440
//   }
// );



    const inbound = [];
    const outbound = [];

    pilots.forEach(p => {
      const route = p.flight_plan?.route?.toUpperCase() || '';
      const lat = p.latitude, lon = p.longitude;
      if (!lat || !lon || !route) return;

      const facility = getCurrentFacility(lat, lon);
      if (!facility) return;

      const expandedRoute = expandRoute(route);
      if (expandedRoute.length < 2) return;

      const nearestWp = findNearestWaypoint(lat, lon, expandedRoute);
      if (!nearestWp) return;

      const idx = expandedRoute.indexOf(nearestWp);
      if (idx === -1) return;

      let boundaryFix = null;

      // First, find next boundary fix ahead
      for (let i = idx + 1; i < expandedRoute.length; i++) {
        if (BOUNDARY_FIXES.includes(expandedRoute[i])) {
          boundaryFix = expandedRoute[i];
          break;
        }
      }
      // If no boundary ahead, fallback to last boundary behind
      if (!boundaryFix) {
        for (let i = idx; i >= 0; i--) {
          if (BOUNDARY_FIXES.includes(expandedRoute[i])) {
            boundaryFix = expandedRoute[i];
            break;
          }
        }
      }
      // Final fallback: raw route check
      if (!boundaryFix) {
        const cleanRouteParts = route.split(/\s+/).map(r => r.split('/')[0].toUpperCase());
        boundaryFix = cleanRouteParts.find(part => BOUNDARY_FIXES.includes(part)) || null;
      }

      if (!boundaryFix) return;

      const centerEstimate = estimateCenterTime(lat, lon, boundaryFix, p.groundspeed || 450);
      const routeDirection = getRouteDirection(expandedRoute);

      let classification = null;
      if (facility === 'ZWY' || facility === 'TTZP') {
        if (boundaryFix) classification = 'INBOUND';
      } else if (facility === 'ZSU') {
        if (boundaryFix) classification = 'OUTBOUND';
        else return;
      }

      if (!classification) return;

      console.log(`[DEBUG] ${p.callsign} | FAC: ${facility} | Nearest: ${nearestWp} | Boundary: ${boundaryFix} | Center ETA: ${centerEstimate} | Class: ${classification} | Dir: ${routeDirection}`);

      const base = {
        id: p.cid,
        Callsign: p.callsign || '',
        Waypoint: boundaryFix, // <- Always boundary shown!
        route,
        "Center Estimate": centerEstimate,
        "Pilot Estimate": '',
        Altitude: '',
        Mach: '',
        Status: "red",
        heading: p.heading,
        lat,
        lon,
        routeDirection,
        utc: Date.now()
      };

      if (classification === 'INBOUND') inbound.push(base);
      if (classification === 'OUTBOUND') outbound.push(base);
    });

    zsuInbound = inbound.sort((a, b) => a.utc - b.utc).slice(0, 15);
    zsuOutbound = outbound.sort((a, b) => a.utc - b.utc).slice(0, 15);

    io.emit('updateInbound', zsuInbound);
    io.emit('updateOutbound', zsuOutbound);

  } catch (err) {
    console.error('Failed to fetch VATSIM data:', err.message);
  }
}

setInterval(fetchVatsimData, 15000);

io.on('connection', (socket) => {
  console.log('User connected');
  socket.emit('updateInbound', zsuInbound);
  socket.emit('updateOutbound', zsuOutbound);
  socket.emit('userInputs', userInputs);

  socket.on('updateField', ({ id, field, value }) => {
    if (!userInputs[id]) userInputs[id] = {};
    userInputs[id][field] = value;
    io.emit('userInputs', userInputs);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

server.listen(3001, () => {
  console.log('Server running on http://localhost:3001');
  fetchVatsimData();
});
