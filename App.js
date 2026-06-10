import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, Alert, Platform
} from 'react-native';
import MapView, { Polyline, Circle, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Constants ───────────────────────────────────────────────────────────────
const LLEIDA_CENTER = { latitude: 41.6177, longitude: 0.6200 };
const STORAGE_KEY = 'lleida_xp_visited_v1';
const DETECT_RADIUS = 25; // metres

// ─── Overpass query ──────────────────────────────────────────────────────────
const OVERPASS_QUERY = `
[out:json][timeout:30];
(
  way["highway"~"^(residential|primary|secondary|tertiary|unclassified|living_street|pedestrian|footway|path|service|primary_link|secondary_link|tertiary_link)$"]
  (41.595,0.575,41.655,0.670);
);
out geom;
`.trim();

// ─── Haversine distance (metres) ─────────────────────────────────────────────
function haversineDist(a, b) {
  const R = 6371000;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

function distToSegment(p, a, b) {
  const toRad = x => (x * Math.PI) / 180;
  const ax = toRad(a.latitude), ay = toRad(a.longitude);
  const bx = toRad(b.latitude), by = toRad(b.longitude);
  const px = toRad(p.latitude), py = toRad(p.longitude);
  const ab2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (ab2 === 0) return haversineDist(p, a);
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ab2;
  t = Math.max(0, Math.min(1, t));
  return haversineDist(p, {
    latitude: a.latitude + t * (b.latitude - a.latitude),
    longitude: a.longitude + t * (b.longitude - a.longitude),
  });
}

function distToPolyline(p, coords) {
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distToSegment(p, coords[i], coords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [streets, setStreets] = useState([]);
  const [visitedIds, setVisitedIds] = useState(new Set());
  const [userPos, setUserPos] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Carregant carrers…');
  const [currentStreet, setCurrentStreet] = useState('');
  const [accuracy, setAccuracy] = useState(null);
  const locationSub = useRef(null);
  const mapRef = useRef(null);

  // Load saved progress
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(val => {
      if (val) setVisitedIds(new Set(JSON.parse(val)));
    });
    loadStreets();
  }, []);

  async function loadStreets() {
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: OVERPASS_QUERY,
      });
      const data = await res.json();
      const parsed = data.elements
        .filter(el => el.type === 'way' && el.geometry)
        .map(el => ({
          id: String(el.id),
          name: el.tags?.name || el.tags?.['name:ca'] || null,
          coords: el.geometry.map(p => ({ latitude: p.lat, longitude: p.lon })),
        }));
      setStreets(parsed);
      setStatusMsg(`${parsed.length} carrers carregats. Prem Iniciar.`);
    } catch (e) {
      setStatusMsg('Error carregant mapa. Comprova connexió.');
    }
  }

  const saveProgress = useCallback(async (ids) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  }, []);

  async function toggleTracking() {
    if (tracking) {
      locationSub.current?.remove();
      locationSub.current = null;
      setTracking(false);
      setStatusMsg('Tracking aturat.');
    } else {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') {
        Alert.alert('Permís denegat', 'Cal permís de ubicació per usar l\'app.');
        return;
      }
      const { status: bg } = await Location.requestBackgroundPermissionsAsync();
      if (bg !== 'granted') {
        Alert.alert(
          'Permís en segon pla',
          'Per al tracking amb pantalla bloquejada cal permís "Sempre". Ves a Configuració → Apps → LleidaXP → Ubicació → Sempre.'
        );
      }
      setTracking(true);
      setStatusMsg('Buscant GPS…');
      locationSub.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 5,
        },
        onPosition
      );
    }
  }

  function onPosition(loc) {
    const { latitude, longitude, accuracy: acc } = loc.coords;
    const pos = { latitude, longitude };
    setUserPos(pos);
    setAccuracy(Math.round(acc));
    setStatusMsg(`GPS actiu · precisió ~${Math.round(acc)}m`);
    detectStreet(pos);
  }

  function detectStreet(pos) {
    let closest = null;
    let minDist = Infinity;
    for (const street of streets) {
      const d = distToPolyline(pos, street.coords);
      if (d < minDist) { minDist = d; closest = street; }
    }
    if (closest && minDist < DETECT_RADIUS) {
      setCurrentStreet(closest.name || 'Carrer sense nom');
      setVisitedIds(prev => {
        if (prev.has(closest.id)) return prev;
        const next = new Set(prev);
        next.add(closest.id);
        saveProgress(next);
        return next;
      });
    }
  }

  function centerOnMe() {
    if (userPos && mapRef.current) {
      mapRef.current.animateToRegion({ ...userPos, latitudeDelta: 0.008, longitudeDelta: 0.008 }, 500);
    }
  }

  function resetProgress() {
    Alert.alert('Reset', 'Vols esborrar tot el progrés?', [
      { text: 'Cancel·la', style: 'cancel' },
      {
        text: 'Esborra', style: 'destructive', onPress: () => {
          setVisitedIds(new Set());
          AsyncStorage.removeItem(STORAGE_KEY);
        }
      },
    ]);
  }

  const total = streets.length;
  const visited = streets.filter(s => visitedIds.has(s.id)).length;
  const pct = total ? Math.round((visited / total) * 100) : 0;

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0f14" />

      {/* Header */}
      <View style={s.header}>
        <Text style={s.logo}>Lleida<Text style={s.logoAccent}>XP</Text></Text>
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{visited}</Text>
            <Text style={s.statLabel}>VISITADES</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{total || '—'}</Text>
            <Text style={s.statLabel}>TOTAL</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{pct}%</Text>
            <Text style={s.statLabel}>COBERT</Text>
          </View>
        </View>
      </View>

      {/* Map */}
      <MapView
        ref={mapRef}
        style={s.map}
        initialRegion={{ ...LLEIDA_CENTER, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
        mapType="standard"
        showsUserLocation={false}
        showsCompass={true}
      >
        {streets.map(street => (
          <Polyline
            key={street.id}
            coordinates={street.coords}
            strokeColor={visitedIds.has(street.id) ? '#00e5a0' : '#2a3040'}
            strokeWidth={visitedIds.has(street.id) ? 4 : 2}
          />
        ))}
        {userPos && (
          <>
            <Marker coordinate={userPos} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={s.userDot} />
            </Marker>
            {accuracy && (
              <Circle
                center={userPos}
                radius={accuracy}
                fillColor="rgba(77,171,247,0.1)"
                strokeColor="rgba(77,171,247,0.4)"
                strokeWidth={1}
              />
            )}
          </>
        )}
      </MapView>

      {/* Bottom panel */}
      <View style={s.panel}>
        {/* Progress bar */}
        <View style={s.progressBg}>
          <View style={[s.progressFill, { width: `${pct}%` }]} />
        </View>

        {/* Current street */}
        <Text style={s.streetLabel}>
          {currentStreet ? `Estàs a: ` : 'Inicia el tracking per começar'}
          {currentStreet ? <Text style={s.streetName}>{currentStreet}</Text> : null}
        </Text>

        {/* Status */}
        <View style={s.statusRow}>
          <View style={[s.dot, tracking && s.dotActive]} />
          <Text style={s.statusText}>{statusMsg}</Text>
        </View>

        {/* Buttons */}
        <View style={s.btnRow}>
          <TouchableOpacity
            style={[s.btn, s.btnPrimary, tracking && s.btnStop]}
            onPress={toggleTracking}
          >
            <Text style={s.btnPrimaryText}>{tracking ? '⏹ Aturar' : '▶ Iniciar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={centerOnMe}>
            <Text style={s.btnSecondaryText}>⊕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={resetProgress}>
            <Text style={s.btnSecondaryText}>↺</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0f14' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: '#161921', borderBottomWidth: 1, borderBottomColor: '#252a36',
  },
  logo: { fontSize: 20, fontWeight: '800', color: '#e8eaf0' },
  logoAccent: { color: '#00e5a0' },
  statsRow: { flexDirection: 'row', gap: 16 },
  stat: { alignItems: 'center' },
  statVal: { fontSize: 16, fontWeight: '700', color: '#00e5a0' },
  statLabel: { fontSize: 9, color: '#5a6175' },
  map: { flex: 1 },
  userDot: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: '#4dabf7', borderWidth: 2, borderColor: '#fff',
  },
  panel: {
    backgroundColor: '#161921', borderTopWidth: 1, borderTopColor: '#252a36',
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 20,
  },
  progressBg: { height: 3, backgroundColor: '#252a36', borderRadius: 2, marginBottom: 10 },
  progressFill: { height: 3, backgroundColor: '#00e5a0', borderRadius: 2 },
  streetLabel: { fontSize: 12, color: '#5a6175', marginBottom: 8, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  streetName: { color: '#00e5a0', fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#5a6175' },
  dotActive: { backgroundColor: '#00e5a0' },
  statusText: { fontSize: 12, color: '#5a6175', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', flex: 1 },
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { flex: 1, backgroundColor: '#00e5a0' },
  btnStop: { backgroundColor: '#ff6b35' },
  btnPrimaryText: { color: '#000', fontWeight: '700', fontSize: 14 },
  btnSecondary: { width: 48, backgroundColor: '#252a36' },
  btnSecondaryText: { color: '#4dabf7', fontSize: 18 },
});