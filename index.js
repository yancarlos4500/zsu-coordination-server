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
const io = new Server(server, {
  cors: { origin: '*' }
});

let zsuInbound = [];
let zsuOutbound = [];
let userInputs = {};

const AIRWAY_TO_WAYPOINT = {"L455": "KINCH", "L456": "HANCY", "L458": "CHEDR", "M597": "KEEKA", "Y315": "KEEKA", "L459": "KEEKA", "L329": "KEEKA", "L327": "OPAUL", "L461": "OPAUL", "M525": "SOCCO", "L462": "DAWIN", "L335": "OBIKE", "M576": "OBIKE"};

const WAYPOINTS = ['KINCH', 'HANCY', 'CHEDR', 'KEEKA', 'OPAUL', 'SOCCO', 'DAWIN', 'OBIKE'];
const WAYPOINT_COORDS = {
  'KINCH': [-67.197817, 21.621478],
  'HANCY': [-66.170619, 22.036886],
  'CHEDR': [-66.009619, 22.046697],
  'KEEKA': [-65.134825, 22.097069],
  'OPAUL': [-63.846578, 21.856597],
  'SOCCO': [-63.061878, 21.116403],
  'DAWIN': [-62.457578, 20.538769],
  'OBIKE': [-61.767164, 19.341283]
};

const boundaries = JSON.parse(fs.readFileSync('./Boundaries.geojson', 'utf8'));
const zsuBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'TJZS');
const zwyBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'KZWY');

function toZuluTime(timestamp) {
  if (!timestamp || isNaN(timestamp)) return 'N/A';
  const date = new Date(timestamp * 1000);
  if (isNaN(date.getTime())) return 'N/A';
  return date.toISOString().split('T')[1].replace('Z', '').slice(0, 5) + 'Z';
}

function isInsideZSU(lat, lon) {
  if (!zsuBoundary) return false;
  const pt = turf.point([lon, lat]);
  return turf.booleanPointInPolygon(pt, zsuBoundary);
}

function estimateTimeToCross(lat, lon, wp, groundspeed, heading, altitude) {
  if (!WAYPOINT_COORDS[wp] || !lat || !lon || !groundspeed) return 'N/A';

  const from = turf.point([lon, lat]);
  const to = turf.point(WAYPOINT_COORDS[wp]);

  // 1. Get great-circle distance (nautical miles)
  const distanceNm = turf.distance(from, to, { units: 'nauticalmiles' });

  // 2. Get bearing (track) toward waypoint — for future use or logging
  const bearingToFix = turf.bearing(from, to);

  // 3. Calculate estimated time using given groundspeed
  const timeHours = distanceNm / groundspeed;
  const eta = new Date(Date.now() + timeHours * 3600 * 1000);

  return eta.toISOString().split('T')[1].slice(0, 5) + 'Z';
}

const fetchVatsimData = async () => {
  try {
    const res = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
    const { pilots } = res.data;

    const inbound = [];
    const outbound = [];

    pilots.forEach(p => {
      const route = p.flight_plan?.route?.toUpperCase() || '';
      
      let match = WAYPOINTS.find(wp => route.includes(wp));
      if (!match) {
        const airwayMatch = Object.keys(AIRWAY_TO_WAYPOINT).find(airway => route.includes(airway));
        if (airwayMatch) {
          match = AIRWAY_TO_WAYPOINT[airwayMatch];
        }
      }
      if (!match) return;

      const lat = p.latitude;
      const lon = p.longitude;
      if (!lat || !lon) return;

      const groundspeed = p.groundspeed || 0;
      const estimate = estimateTimeToCross(lat, lon, match, groundspeed);

      console.log('[WAYPOINT]', match, WAYPOINT_COORDS[match]);
      console.log('[GROUND SPEED]', groundspeed);
      console.log('[CENTER ESTIMATE]', estimate);

      console.log("CHECK:", {
    callsign: p.callsign,
    waypoint: match,
    insideZSU: isInsideZSU(lat, lon),
    lat,
    lon,
    route: p.flight_plan?.route
  });

  const base = {
        id: p.cid,
        Callsign: p.callsign || '',
        Waypoint: match,
        "Center Estimate": estimate,
        Altitude: p.altitude?.toString() || '',
        Mach: p.groundspeed ? (p.groundspeed / 666).toFixed(2) : '',
        "Status": "red",
        lat,
        lon,
        utc: Date.now()
      };

      if (isInsideZSU(lat, lon)) {
        outbound.push(base);
      } else {
      if (p.last_fir === 'KZWY') inbound.push(base);  // Only show aircraft coming from ZWY
      }
    });

    zsuInbound = inbound.sort((a, b) => a.utc - b.utc).slice(0, 15);
    zsuOutbound = outbound.sort((a, b) => a.utc - b.utc).slice(0, 15);

    console.log("INBOUND:", zsuInbound.map(f => ({ Callsign: f.Callsign, Center: f["Center Estimate"] })));
    console.log("OUTBOUND:", zsuOutbound.map(f => ({ Callsign: f.Callsign, Center: f["Center Estimate"] })));

    io.emit('updateInbound', zsuInbound);
    io.emit('updateOutbound', zsuOutbound);
  } catch (err) {
    console.error('Failed to fetch VATSIM data:', err.message);
  }
};

setInterval(fetchVatsimData, 15000);

io.on('connection', (socket) => {
  console.log('User connected');

  socket.emit('updateInbound', zsuInbound);
  socket.emit('updateOutbound', zsuOutbound);
  socket.emit('zwyBoundary', zwyBoundary);
  socket.emit('userInputs', userInputs);

  socket.on('updateField', ({ id, field, value }) => {
    if (!userInputs[id]) userInputs[id] = {};
    userInputs[id][field] = value;
    io.emit('userInputs', userInputs);
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