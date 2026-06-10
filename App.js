import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, Alert, Platform, AppState, Vibration
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'lleida_xp_v6';
const BG_TASK = 'lleida-bg-v6';
const DETECT_RADIUS = 25;

// Milestones de felicitació a partir del 50%
const MILESTONES = [50, 60, 70, 80, 90, 100];

// Colors de calor: de vermell transparent → vermell → taronja → groc → verd clar → verd
const HEAT_COLORS = [
  { visits: 0,  color: '#ff4444', opacity: 0.45, weight: 3 },  // no visitat
  { visits: 1,  color: '#00e5a0', opacity: 0.7,  weight: 3 },  // 1 vegada
  { visits: 3,  color: '#00c87a', opacity: 0.8,  weight: 4 },  // 3 vegades
  { visits: 6,  color: '#00a855', opacity: 0.9,  weight: 5 },  // 6 vegades
  { visits: 10, color: '#007a3d', opacity: 1.0,  weight: 6 },  // 10+ vegades
];

function getHeatStyle(visits) {
  let style = HEAT_COLORS[0];
  for (const h of HEAT_COLORS) {
    if (visits >= h.visits) style = h;
  }
  return style;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function distToSeg(p, a, b) {
  const toRad = x => x * Math.PI / 180;
  const ax=toRad(a[0]),ay=toRad(a[1]),bx=toRad(b[0]),by=toRad(b[1]),px=toRad(p[0]),py=toRad(p[1]);
  const ab2=(bx-ax)**2+(by-ay)**2;
  if(ab2===0) return haversineMeters(p,a);
  const t=Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/ab2));
  return haversineMeters(p,[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
}

function distToPolyline(p, coords) {
  let min = Infinity;
  for (let i = 0; i < coords.length-1; i++) {
    const d = distToSeg(p, coords[i], coords[i+1]);
    if (d < min) min = d;
  }
  return min;
}

// ─── Background task ──────────────────────────────────────────────────────────
TaskManager.defineTask(BG_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const { latitude, longitude } = data.locations[0].coords;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : { visits: {}, streets: [] };
    if (!saved.streets?.length) return;

    const pos = [latitude, longitude];
    let minDist = Infinity, closest = null;
    for (const street of saved.streets) {
      const d = distToPolyline(pos, street.coords);
      if (d < minDist) { minDist = d; closest = street; }
    }

    if (closest && minDist < DETECT_RADIUS) {
      const visits = { ...(saved.visits || {}) };
      visits[closest.id] = (visits[closest.id] || 0) + 1;
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, visits }));
    }
  } catch(e) {}
});

// ─── Map HTML ─────────────────────────────────────────────────────────────────
const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body,#map{width:100%;height:100%}
  .leaflet-control-attribution{display:none}
</style>
</head>
<body><div id="map"></div>
<script>
var map=L.map('map',{center:[41.6177,0.6200],zoom:15});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
var segs={}, userMarker=null, userCircle=null;

// Exclou carrers d'horta i camins rurals
var Q='[out:json][timeout:30];(way["highway"~"^(residential|primary|secondary|tertiary|unclassified|living_street|pedestrian|primary_link|secondary_link|tertiary_link)$"]["name"](41.595,0.575,41.655,0.670););out geom;';

fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:Q})
  .then(function(r){return r.json();}).then(function(data){
    var streets=[];
    data.elements.forEach(function(el){
      if(el.type!=='way'||!el.geometry)return;
      var coords=el.geometry.map(function(p){return[p.lat,p.lon]});
      var layer=L.polyline(coords,{color:'#ff4444',weight:3,opacity:0.45}).addTo(map);
      segs[el.id]={layer:layer};
      streets.push({id:String(el.id),name:(el.tags&&el.tags.name)||null,coords:coords});
    });
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'loaded',count:streets.length,streets:streets
    }));
  }).catch(function(){
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'error'}));
  });

function updateHeat(updates){
  // updates: [{id, color, opacity, weight}, ...]
  updates.forEach(function(u){
    if(segs[u.id])segs[u.id].layer.setStyle({color:u.color,weight:u.weight,opacity:u.opacity});
  });
}
function updatePos(lat,lng,acc){
  var p=[lat,lng];
  if(!userMarker){
    userMarker=L.circleMarker(p,{radius:8,fillColor:'#4dabf7',fillOpacity:1,color:'#fff',weight:2}).addTo(map);
    userCircle=L.circle(p,{radius:acc,color:'#4dabf7',fillColor:'#4dabf7',fillOpacity:0.08,weight:1}).addTo(map);
    map.setView(p,17);
  } else {
    userMarker.setLatLng(p);
    userCircle.setLatLng(p);
    userCircle.setRadius(acc);
  }
}
function centerOnUser(){if(userMarker)map.setView(userMarker.getLatLng(),17);}
function resetMap(){
  Object.values(segs).forEach(function(s){
    s.layer.setStyle({color:'#ff4444',weight:3,opacity:0.45});
  });
}
</script></body></html>`;

// ─── Milestone messages ───────────────────────────────────────────────────────
const MILESTONE_MSG = {
  50:  { title: '🎉 Meitat de Lleida!',    body: 'Ja has cobert el 50% dels carrers. Vas per bon camí!' },
  60:  { title: '💪 60% cobert!',          body: 'Més de la meitat! Lleida ja no té secrets per a tu.' },
  70:  { title: '🔥 70% cobert!',          body: 'Ja coneixes 7 de cada 10 carrers de Lleida. Increïble!' },
  80:  { title: '⭐ 80% cobert!',          body: 'Gairebé un expert de Lleida. Continua!' },
  90:  { title: '🏆 90% cobert!',          body: 'Quasi, quasi... La meta és a prop!' },
  100: { title: '🥇 Lleida completada!',   body: 'Has caminat per tots els carrers de Lleida. Llegenda!' },
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [statusMsg, setStatusMsg] = useState('Carregant mapa…');
  const [currentStreet, setCurrentStreet] = useState('');
  const [tracking, setTracking] = useState(false);
  const [visited, setVisited] = useState(0);
  const [total, setTotal] = useState(0);
  const webRef = useRef(null);
  const locationSub = useRef(null);
  const streetsRef = useRef([]);
  const visitsRef = useRef({});   // { streetId: count }
  const appState = useRef(AppState.currentState);
  const lastMilestone = useRef(0);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async nextState => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        await syncFromStorage();
      }
      appState.current = nextState;
    });
    return () => sub.remove();
  }, []);

  async function syncFromStorage() {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const visits = saved.visits || {};
    // Carrers amb visites noves
    const updates = [];
    for (const [id, count] of Object.entries(visits)) {
      const prev = visitsRef.current[id] || 0;
      if (count !== prev) {
        const style = getHeatStyle(count);
        updates.push({ id, ...style });
      }
    }
    if (updates.length > 0) {
      webRef.current?.injectJavaScript(`updateHeat(${JSON.stringify(updates)}); true;`);
    }
    visitsRef.current = visits;
    const visitedCount = Object.keys(visits).length;
    setVisited(visitedCount);
  }

  function checkMilestone(visitedCount, totalCount) {
    if (!totalCount) return;
    const pct = Math.round((visitedCount / totalCount) * 100);
    for (const m of MILESTONES) {
      if (pct >= m && lastMilestone.current < m) {
        lastMilestone.current = m;
        Vibration.vibrate([0, 200, 100, 200]);
        const msg = MILESTONE_MSG[m];
        Alert.alert(msg.title, msg.body);
        break;
      }
    }
  }

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'loaded') {
        streetsRef.current = msg.streets;
        setTotal(msg.count);
        setStatusMsg(`${msg.count} carrers. Prem Iniciar.`);
        AsyncStorage.getItem(STORAGE_KEY).then(raw => {
          const saved = raw ? JSON.parse(raw) : { visits: {} };
          saved.streets = msg.streets;
          AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
          const visits = saved.visits || {};
          visitsRef.current = visits;
          const visitedCount = Object.keys(visits).length;
          setVisited(visitedCount);
          if (visitedCount > 0) {
            const updates = Object.entries(visits).map(([id, count]) => ({ id, ...getHeatStyle(count) }));
            webRef.current?.injectJavaScript(`updateHeat(${JSON.stringify(updates)}); true;`);
          }
          // Restaura milestone
          const pct = msg.count ? Math.round((visitedCount / msg.count) * 100) : 0;
          for (const m of [...MILESTONES].reverse()) {
            if (pct >= m) { lastMilestone.current = m; break; }
          }
        });
      } else if (msg.type === 'error') {
        setStatusMsg('Error carregant mapa. Comprova connexió.');
      }
    } catch(e) {}
  }

  function detectStreet(lat, lng) {
    const pos = [lat, lng];
    let minDist = Infinity, closest = null;
    for (const s of streetsRef.current) {
      const d = distToPolyline(pos, s.coords);
      if (d < minDist) { minDist = d; closest = s; }
    }
    if (closest && minDist < DETECT_RADIUS) {
      setCurrentStreet(closest.name || 'Carrer sense nom');
      const prevCount = visitsRef.current[closest.id] || 0;
      const newCount = prevCount + 1;
      visitsRef.current[closest.id] = newCount;
      const newVisited = Object.keys(visitsRef.current).length;
      setVisited(newVisited);
      // Actualitza color al mapa
      const style = getHeatStyle(newCount);
      webRef.current?.injectJavaScript(`updateHeat([${JSON.stringify({ id: closest.id, ...style })}]); true;`);
      // Guarda
      AsyncStorage.getItem(STORAGE_KEY).then(raw => {
        const saved = raw ? JSON.parse(raw) : { streets: [] };
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, visits: visitsRef.current }));
      });
      // Milestone
      checkMilestone(newVisited, streetsRef.current.length);
    }
  }

  async function toggleTracking() {
    if (tracking) {
      locationSub.current?.remove();
      locationSub.current = null;
      await Location.stopLocationUpdatesAsync(BG_TASK).catch(() => {});
      setTracking(false);
      setStatusMsg('Tracking aturat.');
    } else {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') { Alert.alert('Permís denegat', 'Cal permís de ubicació.'); return; }
      await Location.requestBackgroundPermissionsAsync();
      await Location.startLocationUpdatesAsync(BG_TASK, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 10000,
        distanceInterval: 10,
        foregroundService: {
          notificationTitle: 'LleidaXP actiu',
          notificationBody: 'Registrant carrers en segon pla…',
          notificationColor: '#00e5a0',
        },
        pausesUpdatesAutomatically: false,
      });
      setTracking(true);
      setStatusMsg('Buscant GPS…');
      locationSub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 5000, distanceInterval: 5 },
        loc => {
          const { latitude, longitude, accuracy: acc } = loc.coords;
          setStatusMsg(`GPS actiu · ~${Math.round(acc)}m`);
          webRef.current?.injectJavaScript(`updatePos(${latitude},${longitude},${acc}); true;`);
          detectStreet(latitude, longitude);
        }
      );
    }
  }

  function centerOnMe() { webRef.current?.injectJavaScript(`centerOnUser(); true;`); }

  function resetProgress() {
    Alert.alert('Reset', 'Vols esborrar tot el progrés?', [
      { text: 'Cancel·la', style: 'cancel' },
      { text: 'Esborra', style: 'destructive', onPress: async () => {
        visitsRef.current = {};
        lastMilestone.current = 0;
        setVisited(0);
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const saved = raw ? JSON.parse(raw) : {};
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ streets: saved.streets || [], visits: {} }));
        webRef.current?.injectJavaScript(`resetMap(); true;`);
      }}
    ]);
  }

  const pct = total ? Math.round((visited / total) * 100) : 0;

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0f14" />
      <View style={s.header}>
        <Text style={s.logo}>Lleida<Text style={s.accent}>XP</Text></Text>
        <View style={s.statsRow}>
          <View style={s.stat}><Text style={s.statVal}>{visited}</Text><Text style={s.statLabel}>VISITADES</Text></View>
          <View style={s.stat}><Text style={s.statVal}>{total||'—'}</Text><Text style={s.statLabel}>TOTAL</Text></View>
          <View style={s.stat}><Text style={s.statVal}>{pct}%</Text><Text style={s.statLabel}>COBERT</Text></View>
        </View>
      </View>
      <WebView ref={webRef} style={s.map} source={{html:MAP_HTML}} onMessage={onMessage}
        javaScriptEnabled domStorageEnabled geolocationEnabled={false}
        originWhitelist={['*']} mixedContentMode="always" />
      <View style={s.panel}>
        <View style={s.progressBg}><View style={[s.progressFill,{width:`${pct}%`}]}/></View>
        <Text style={s.streetLabel}>
          {currentStreet?'Estàs a: ':'Inicia el tracking per comenzar'}
          {currentStreet?<Text style={s.streetName}>{currentStreet}</Text>:null}
        </Text>
        <View style={s.statusRow}>
          <View style={[s.dot,tracking&&s.dotActive]}/>
          <Text style={s.statusText}>{statusMsg}</Text>
        </View>
        <View style={s.btnRow}>
          <TouchableOpacity style={[s.btn,s.btnPrimary,tracking&&s.btnStop]} onPress={toggleTracking}>
            <Text style={s.btnPrimaryText}>{tracking?'⏹ Aturar':'▶ Iniciar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn,s.btnSecondary]} onPress={centerOnMe}>
            <Text style={s.btnSecText}>⊕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn,s.btnSecondary]} onPress={resetProgress}>
            <Text style={s.btnSecText}>↺</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:'#0d0f14'},
  header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:10,backgroundColor:'#161921',borderBottomWidth:1,borderBottomColor:'#252a36'},
  logo:{fontSize:20,fontWeight:'800',color:'#e8eaf0'},
  accent:{color:'#00e5a0'},
  statsRow:{flexDirection:'row',gap:16},
  stat:{alignItems:'center'},
  statVal:{fontSize:15,fontWeight:'700',color:'#00e5a0'},
  statLabel:{fontSize:9,color:'#5a6175'},
  map:{flex:1},
  panel:{backgroundColor:'#161921',borderTopWidth:1,borderTopColor:'#252a36',paddingHorizontal:16,paddingTop:10,paddingBottom:20},
  progressBg:{height:3,backgroundColor:'#252a36',borderRadius:2,marginBottom:10},
  progressFill:{height:3,backgroundColor:'#00e5a0',borderRadius:2},
  streetLabel:{fontSize:12,color:'#5a6175',marginBottom:8,fontFamily:Platform.OS==='ios'?'Courier':'monospace'},
  streetName:{color:'#00e5a0',fontWeight:'700'},
  statusRow:{flexDirection:'row',alignItems:'center',gap:8,marginBottom:10},
  dot:{width:8,height:8,borderRadius:4,backgroundColor:'#5a6175'},
  dotActive:{backgroundColor:'#00e5a0'},
  statusText:{fontSize:12,color:'#5a6175',fontFamily:Platform.OS==='ios'?'Courier':'monospace',flex:1},
  btnRow:{flexDirection:'row',gap:8},
  btn:{borderRadius:8,paddingVertical:12,alignItems:'center',justifyContent:'center'},
  btnPrimary:{flex:1,backgroundColor:'#00e5a0'},
  btnStop:{backgroundColor:'#ff6b35'},
  btnPrimaryText:{color:'#000',fontWeight:'700',fontSize:14},
  btnSecondary:{width:48,backgroundColor:'#252a36'},
  btnSecText:{color:'#4dabf7',fontSize:18},
});
