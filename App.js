import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, Alert, Platform
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'lleida_xp_v3';

const MAP_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body, #map { width:100%; height:100%; background:#0d0f14; }
  .leaflet-tile { filter: invert(1) hue-rotate(200deg) saturate(0.4) brightness(0.85); }
  .leaflet-control-attribution { display:none; }
</style>
</head>
<body>
<div id="map"></div>
<script>
var map = L.map('map', { center:[41.6177,0.6200], zoom:15, zoomControl:true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);

var allSegments = {};
var userMarker = null;
var userCircle = null;

// Candidat actual: carrer on s'esta caminant ara
var candidate = null;       // { id, name, entryPos }
var CANDIDATE_DIST = 25;    // metres per considerar "dins el carrer"
var WALK_REQUIRED = 15;     // metres que cal caminar dins el carrer

var OVERPASS = '[out:json][timeout:30];(way["highway"~"^(residential|primary|secondary|tertiary|unclassified|living_street|pedestrian|footway|path|service|primary_link|secondary_link|tertiary_link)$"](41.595,0.575,41.655,0.670););out geom;';

fetch('https://overpass-api.de/api/interpreter', { method:'POST', body:OVERPASS })
  .then(r => r.json())
  .then(data => {
    data.elements.forEach(el => {
      if (el.type !== 'way' || !el.geometry) return;
      var coords = el.geometry.map(p => [p.lat, p.lon]);
      // No visitat = vermell
      var layer = L.polyline(coords, { color:'#e05050', weight:2.5, opacity:0.6 }).addTo(map);
      allSegments[el.id] = { layer, name: el.tags && el.tags.name || null, coords };
    });
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'loaded', count: Object.keys(allSegments).length
    }));
  })
  .catch(() => {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type:'error' }));
  });

function updatePosition(lat, lng, acc) {
  var pos = [lat, lng];
  if (!userMarker) {
    userMarker = L.circleMarker(pos, { radius:8, fillColor:'#4dabf7', fillOpacity:1, color:'#fff', weight:2 }).addTo(map);
    userCircle = L.circle(pos, { radius:acc, color:'#4dabf7', fillColor:'#4dabf7', fillOpacity:0.08, weight:1 }).addTo(map);
    map.setView(pos, 17);
  } else {
    userMarker.setLatLng(pos);
    userCircle.setLatLng(pos);
    userCircle.setRadius(acc);
  }
  detectStreet(lat, lng);
}

function markVisited(ids) {
  ids.forEach(function(id) {
    if (allSegments[id]) {
      allSegments[id].layer.setStyle({ color:'#00e5a0', weight:4, opacity:0.9 });
    }
  });
}

function detectStreet(lat, lng) {
  var minDist = Infinity, closest = null;
  Object.entries(allSegments).forEach(function(entry) {
    var id = entry[0], seg = entry[1];
    var d = distToPolyline([lat,lng], seg.coords);
    if (d < minDist) { minDist = d; closest = { id:id, name:seg.name }; }
  });

  if (closest && minDist < CANDIDATE_DIST) {
    if (!candidate || candidate.id !== closest.id) {
      // Entrem a un carrer nou
      candidate = { id: closest.id, name: closest.name, entryLat: lat, entryLng: lng };
    } else {
      // Continuem al mateix carrer — comprovem distancia recorreguda
      var walked = haver([lat,lng], [candidate.entryLat, candidate.entryLng]);
      if (walked >= WALK_REQUIRED) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type:'street', id: candidate.id, name: candidate.name
        }));
        // Reiniciem el candidat per no re-enviar contínuament
        candidate.entryLat = lat;
        candidate.entryLng = lng;
      }
    }
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'nearstreet', name: closest.name || 'Carrer sense nom'
    }));
  } else {
    candidate = null;
  }
}

function distToPolyline(p, coords) {
  var min = Infinity;
  for (var i = 0; i < coords.length-1; i++) {
    var d = distToSeg(p, coords[i], coords[i+1]);
    if (d < min) min = d;
  }
  return min;
}

function distToSeg(p, a, b) {
  var ax=toRad(a[0]),ay=toRad(a[1]),bx=toRad(b[0]),by=toRad(b[1]),px=toRad(p[0]),py=toRad(p[1]);
  var ab2=(bx-ax)**2+(by-ay)**2;
  if(ab2===0) return haver(p,a);
  var t=Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/ab2));
  return haver(p,[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
}

function haver(a,b) {
  var R=6371000;
  var dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);
  var s=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;
  return R*2*Math.asin(Math.sqrt(s));
}

function toRad(x) { return x*Math.PI/180; }

function centerOnUser() {
  if (userMarker) map.setView(userMarker.getLatLng(), 17);
}

function resetMap() {
  Object.values(allSegments).forEach(function(seg) {
    seg.layer.setStyle({ color:'#e05050', weight:2.5, opacity:0.6 });
  });
  candidate = null;
}
</script>
</body>
</html>
`;

export default function App() {
  const [statusMsg, setStatusMsg] = useState('Carregant mapa…');
  const [currentStreet, setCurrentStreet] = useState('');
  const [tracking, setTracking] = useState(false);
  const [visited, setVisited] = useState(0);
  const [total, setTotal] = useState(0);
  const [kmWalked, setKmWalked] = useState(0);
  const webRef = useRef(null);
  const locationSub = useRef(null);
  const visitedIds = useRef(new Set());
  const lastPos = useRef(null);
  const totalMeters = useRef(0);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(val => {
      if (val) {
        const data = JSON.parse(val);
        visitedIds.current = new Set(data.ids || []);
        totalMeters.current = data.km ? data.km * 1000 : 0;
        setKmWalked(data.km || 0);
      }
    });
  }, []);

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'loaded') {
        setTotal(msg.count);
        setStatusMsg(`${msg.count} carrers carregats. Prem Iniciar.`);
        if (visitedIds.current.size > 0) {
          webRef.current?.injectJavaScript(`markVisited(${JSON.stringify([...visitedIds.current])}); true;`);
          setVisited(visitedIds.current.size);
        }
      } else if (msg.type === 'nearstreet') {
        setCurrentStreet(msg.name);
      } else if (msg.type === 'street') {
        if (!visitedIds.current.has(msg.id)) {
          visitedIds.current.add(msg.id);
          setVisited(visitedIds.current.size);
          saveProgress();
          webRef.current?.injectJavaScript(`markVisited(['${msg.id}']); true;`);
        }
      } else if (msg.type === 'error') {
        setStatusMsg('Error carregant mapa. Comprova connexió.');
      }
    } catch(e) {}
  }

  function saveProgress() {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      ids: [...visitedIds.current],
      km: parseFloat(kmWalked.toFixed(2))
    }));
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon/2)**2;
    return R * 2 * Math.asin(Math.sqrt(s));
  }

  async function toggleTracking() {
    if (tracking) {
      locationSub.current?.remove();
      locationSub.current = null;
      setTracking(false);
      lastPos.current = null;
      setStatusMsg('Tracking aturat.');
    } else {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') {
        Alert.alert('Permís denegat', 'Cal permís de ubicació.');
        return;
      }
      await Location.requestBackgroundPermissionsAsync();
      setTracking(true);
      setStatusMsg('Buscant GPS…');
      locationSub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 5000, distanceInterval: 5 },
        loc => {
          const { latitude, longitude, accuracy: acc } = loc.coords;
          setStatusMsg(`GPS actiu · ~${Math.round(acc)}m precisió`);

          // Calcula km caminats
          if (lastPos.current) {
            const d = haversineMeters(lastPos.current, [latitude, longitude]);
            if (d < 100) { // ignora salts GPS erronis
              totalMeters.current += d;
              const km = parseFloat((totalMeters.current / 1000).toFixed(2));
              setKmWalked(km);
            }
          }
          lastPos.current = [latitude, longitude];

          webRef.current?.injectJavaScript(`updatePosition(${latitude}, ${longitude}, ${acc}); true;`);
        }
      );
    }
  }

  function centerOnMe() {
    webRef.current?.injectJavaScript(`centerOnUser(); true;`);
  }

  function resetProgress() {
    Alert.alert('Reset', 'Vols esborrar tot el progrés i els km?', [
      { text: 'Cancel·la', style: 'cancel' },
      { text: 'Esborra', style: 'destructive', onPress: () => {
        visitedIds.current = new Set();
        totalMeters.current = 0;
        setVisited(0);
        setKmWalked(0);
        AsyncStorage.removeItem(STORAGE_KEY);
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
          <View style={s.stat}><Text style={s.statVal}>{kmWalked}</Text><Text style={s.statLabel}>KM</Text></View>
        </View>
      </View>
      <WebView
        ref={webRef}
        style={s.map}
        source={{ html: MAP_HTML }}
        onMessage={onMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        geolocationEnabled={false}
        originWhitelist={['*']}
        mixedContentMode="always"
      />
      <View style={s.panel}>
        <View style={s.progressBg}><View style={[s.progressFill, { width: `${pct}%` }]} /></View>
        <Text style={s.streetLabel}>
          {currentStreet ? 'Estàs a: ' : 'Inicia el tracking per comenzar'}
          {currentStreet ? <Text style={s.streetName}>{currentStreet}</Text> : null}
        </Text>
        <View style={s.statusRow}>
          <View style={[s.dot, tracking && s.dotActive]} />
          <Text style={s.statusText}>{statusMsg}</Text>
        </View>
        <View style={s.btnRow}>
          <TouchableOpacity style={[s.btn, s.btnPrimary, tracking && s.btnStop]} onPress={toggleTracking}>
            <Text style={s.btnPrimaryText}>{tracking ? '⏹ Aturar' : '▶ Iniciar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={centerOnMe}>
            <Text style={s.btnSecText}>⊕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={resetProgress}>
            <Text style={s.btnSecText}>↺</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex:1, backgroundColor:'#0d0f14' },
  header: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:16, paddingVertical:10, backgroundColor:'#161921', borderBottomWidth:1, borderBottomColor:'#252a36' },
  logo: { fontSize:20, fontWeight:'800', color:'#e8eaf0' },
  accent: { color:'#00e5a0' },
  statsRow: { flexDirection:'row', gap:12 },
  stat: { alignItems:'center' },
  statVal: { fontSize:15, fontWeight:'700', color:'#00e5a0' },
  statLabel: { fontSize:9, color:'#5a6175' },
  map: { flex:1 },
  panel: { backgroundColor:'#161921', borderTopWidth:1, borderTopColor:'#252a36', paddingHorizontal:16, paddingTop:10, paddingBottom:20 },
  progressBg: { height:3, backgroundColor:'#252a36', borderRadius:2, marginBottom:10 },
  progressFill: { height:3, backgroundColor:'#00e5a0', borderRadius:2 },
  streetLabel: { fontSize:12, color:'#5a6175', marginBottom:8, fontFamily: Platform.OS==='ios'?'Courier':'monospace' },
  streetName: { color:'#00e5a0', fontWeight:'700' },
  statusRow: { flexDirection:'row', alignItems:'center', gap:8, marginBottom:10 },
  dot: { width:8, height:8, borderRadius:4, backgroundColor:'#5a6175' },
  dotActive: { backgroundColor:'#00e5a0' },
  statusText: { fontSize:12, color:'#5a6175', fontFamily: Platform.OS==='ios'?'Courier':'monospace', flex:1 },
  btnRow: { flexDirection:'row', gap:8 },
  btn: { borderRadius:8, paddingVertical:12, alignItems:'center', justifyContent:'center' },
  btnPrimary: { flex:1, backgroundColor:'#00e5a0' },
  btnStop: { backgroundColor:'#ff6b35' },
  btnPrimaryText: { color:'#000', fontWeight:'700', fontSize:14 },
  btnSecondary: { width:48, backgroundColor:'#252a36' },
  btnSecText: { color:'#4dabf7', fontSize:18 },
});
