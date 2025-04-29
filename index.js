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

const ZSU_countryICAO = ['TJ', 'TN', 'TQ', 'TI', 'TU'];

const WAYPOINT_DATA_BY_FACILITY = {
  "ZWY": {
    "KINCH": { airways: ["L455"], coords: [-67.197817, 21.621478] },
    "HANCY": { airways: ["L456"], coords: [-66.170619, 22.036886] },
    "CHEDR": { airways: ["L458"], coords: [-66.009619, 22.046697] },
    "KEEKA": { airways: ["M597", "Y315", "L459", "L329"], coords: [-65.134825, 22.097069] },
    "OPAUL": { airways: ["L327", "L461"], coords: [-63.846578, 21.856597] },
    "SOCCO": { airways: ["M525"], coords: [-63.061878, 21.116403] },
    "DAWIN": { airways: ["L462"], coords: [-62.457578, 20.538769] }
  },
  "TTZP": {
    "OBIKE": { airways: ["L335", "M576"], coords: [-61.767164, 19.341283] },
    "ANADA": { airways: ["L467", "UG449", "UL452", "G449", "L343", "L452", "L459"], coords: [-64.146247, 15] },
    "GEECE": { airways: ["L466", "L776", "UL776"], coords: [-63.25, 15] },
    "ILURI": { airways: ["UA555", "UL454", "Y185", "A555", "L454"], coords: [-63.0, 16.301111] },
    "MODUX": { airways: ["R888", "UR888", "Y260"], coords: [-63.0, 16.958889] },
    "GABAR": { airways: ["L349", "UG633", "Y280", "G633", "UT349"], coords: [-63.0, 17.353333] },
    "ZPATA": { airways: ["A517", "L329", "UL329"], coords: [-62.833056, 17.473056] },
    "ELOPO": { airways: ["L577", "Y318", "L451", "UB520", "Y355", "Y290", "B520", "A638"], coords: [-62.554389, 17.650056] },
    "LAMKN": { airways: ["L462", "UL462"], coords: [-61.966111, 18] }
  }
};


const boundaries = JSON.parse(fs.readFileSync('./Boundaries.geojson', 'utf8'));
const zsuBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'TJZS');
const zwyBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'KZWY');
const ttzpBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'TTZP');
const svzmBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'SVZM');
const tncfBoundary = boundaries.features.find(f => f.properties && f.properties.id === 'TNCF');

function toZuluTime(timestamp) {
  if (!timestamp || isNaN(timestamp)) return 'N/A';
  const date = new Date(timestamp * 1000);
  if (isNaN(date.getTime())) return 'N/A';
  return date.toISOString().split('T')[1].slice(0, 5) + 'Z';
}

function isInsideZSU(lat, lon) {
  if (!zsuBoundary) return false;
  const pt = turf.point([lon, lat]);
  return turf.booleanPointInPolygon(pt, zsuBoundary);
}

function isInsideZWY(lat, lon) {
  if (!zwyBoundary) return false;
  const pt = turf.point([lon, lat]);
  return turf.booleanPointInPolygon(pt, zwyBoundary);
}

function isInsideTTZP(lat, lon) {
  if (!ttzpBoundary) return false;
  const pt = turf.point([lon, lat]);
  return turf.booleanPointInPolygon(pt, ttzpBoundary);
}

function estimateTimeToCross(lat, lon, wp, facility, groundspeed) {
  if (!WAYPOINT_DATA_BY_FACILITY[facility]?.[wp]?.coords || !lat || !lon || !groundspeed) return 'N/A';

  const from = turf.point([lon, lat]);
  const to = turf.point(WAYPOINT_DATA_BY_FACILITY[facility][wp].coords);

  const distanceNm = turf.distance(from, to, { units: 'nauticalmiles' });
  const timeHours = distanceNm / groundspeed;
  const eta = new Date(Date.now() + timeHours * 3600 * 1000);

  return eta.toISOString().split('T')[1].slice(0, 5) + 'Z';
}

function findWaypoint(route, facility) {
  if (!facility || !WAYPOINT_DATA_BY_FACILITY[facility]) return null;

  // First check for a direct waypoint match
  for (const wp of Object.keys(WAYPOINT_DATA_BY_FACILITY[facility])) {
    if (route.includes(wp)) return wp;
  }

  // Then check for airway match
  for (const [wp, data] of Object.entries(WAYPOINT_DATA_BY_FACILITY[facility])) {
    if (data.airways.some(airway => route.includes(airway))) {
      
      return wp;
    }
  }

  return null;
}

function getCurrentFacility(lat, lon) {
  if (isInsideZWY(lat, lon)) return "ZWY";
  if (isInsideTTZP(lat, lon)) return "TTZP";
  if (isInsideZSU(lat, lon)) return "ZSU";
  
  return null; // Not inside any known facility
}

const fetchVatsimData = async () => {
  try {
    const res = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
    const { pilots } = res.data;

    const inbound = [];
    const outbound = [];

    let type;
    let match;
    pilots.forEach(p => {
      const route = p.flight_plan?.route?.toUpperCase() || '';
      const dest = p.flight_plan?.arrival?.toUpperCase() || '';
      const lat = p.latitude;
      const lon = p.longitude;
      if (!lat || !lon) return;
      

      
      const countryICAO = dest.slice(0, 2);
      // First, figure out where the aircraft is
      const currentfacility = getCurrentFacility(lat, lon);
      let nextFacility;
      if (!currentfacility) return;
      
      if (currentfacility == "ZWY")
        {
          // if (p.heading >= 270 || p.heading <= 110) {
          //   outbound.push(base);
          // } else {
          // if (isInsideZWY(lat, lon)  && (p.heading < 270 && p.heading > 110)) inbound.push(base);  // Only show aircraft coming from ZWY
          // }
             if (p.heading < 270 && p.heading > 110)
             {
              match = findWaypoint(route, currentfacility);
               if (!match) return;
               type = 1;
             }
          
        }
        if (currentfacility == "TTZP")
          {
               if (p.heading >= 210 || p.heading <= 50)
               {
                match = findWaypoint(route, currentfacility);
                 if (!match) return;
                 type = 1;
               }
            
          }
          if (currentfacility == "ZSU")
            {
              if (p.heading >=60 && p.heading <= 240) {
                if  (ZSU_countryICAO.includes(countryICAO) == false && dest != 'TFFG')
                  {
                    nextFacility = "TTZP";
                    match = findWaypoint(route,nextFacility);
                    console.log(match);
                    
                    if (!match) return;
                    type = 1;
                  }
                  
                }
                else if (p.heading >= 270 || p.heading <= 110) {
                  nextFacility = "ZWY";
                   match = findWaypoint(route, nextFacility);
                  if (!match) return;
                  type = 2;
                  } 
              
            }

      
      // Now, only search within the facility's waypoints
      


      const groundspeed = p.groundspeed || 0;
      const centerEstimate = estimateTimeToCross(lat, lon, match, nextFacility, groundspeed);
      const centerHour = parseInt(centerEstimate.slice(0, 2));
      const centerMin = parseInt(centerEstimate.slice(3, 5));
      const now = new Date();
      const centerEstimateDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), centerHour, centerMin));
      const diffMin = (centerEstimateDate - now) / 1000 / 60;


      console.log(groundspeed);
      
      if (diffMin > 45 || isNaN(diffMin)) {
        return false;   // Muted color for aircraft with estimate older than 30 minutes
      } 

   
      

      const base = {
        id: p.cid,
        Callsign: p.callsign || '',
        Waypoint: match,
        route: route,
        "Center Estimate": centerEstimate,
        "Pilot Estimate": '',
        Altitude: '',
        Mach: '',
        Status: "red",
        heading: p.heading,
        lat,
        lon,
        utc: Date.now()
      };

      if(type == 1) inbound.push(base);
      if(type == 2) outbound.push(base);

      console.log(base);
      

     
        

     

    });

    zsuInbound = inbound.sort((a, b) => a.utc - b.utc).slice(0, 15);
    zsuOutbound = outbound.sort((a, b) => a.utc - b.utc).slice(0, 15);

    console.log("INBOUND:", zsuInbound.map(f => ({ Callsign: f.Callsign, TCP: f.Waypoint ,Center: f["Center Estimate"] })));
    console.log("OUTBOUND:", zsuOutbound.map(f => ({ Callsign: f.Callsign, TCP: f.Waypoint ,Center: f["Center Estimate"] })));

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