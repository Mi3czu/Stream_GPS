import React, { useEffect } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './gps-map.css';

const DEFAULT_CENTER = [52.2297, 21.0122];

const distanceMeters = (first, second) => {
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos(((first[0] + second[0]) / 2) * Math.PI / 180);
  return Math.hypot((second[0] - first[0]) * latitudeScale, (second[1] - first[1]) * longitudeScale);
};

const interpolate = (first, second, fraction) => [
  first[0] + (second[0] - first[0]) * fraction,
  first[1] + (second[1] - first[1]) * fraction
];

const roundedSegment = (segment) => {
  if (segment.length < 3) return segment;
  const rounded = [segment[0]];
  for (let index = 1; index < segment.length - 1; index += 1) {
    const previous = segment[index - 1];
    const corner = segment[index];
    const next = segment[index + 1];
    const incomingLength = distanceMeters(previous, corner);
    const outgoingLength = distanceMeters(corner, next);
    const longitudeScale = 111320 * Math.cos(corner[0] * Math.PI / 180);
    const incoming = [(corner[0] - previous[0]) * 111320 / incomingLength, (corner[1] - previous[1]) * longitudeScale / incomingLength];
    const outgoing = [(next[0] - corner[0]) * 111320 / outgoingLength, (next[1] - corner[1]) * longitudeScale / outgoingLength];
    const turnDegrees = Math.acos(Math.max(-1, Math.min(1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1]))) * 180 / Math.PI;
    const radius = Math.min(8, incomingLength * 0.25, outgoingLength * 0.25);
    if (!Number.isFinite(turnDegrees) || turnDegrees < 20 || turnDegrees > 180 || radius < 0.35) {
      rounded.push(corner);
      continue;
    }
    const entry = interpolate(corner, previous, radius / incomingLength);
    const exit = interpolate(corner, next, radius / outgoingLength);
    rounded.push(entry);
    for (const fraction of [0.25, 0.5, 0.75]) {
      const first = interpolate(entry, corner, fraction);
      const second = interpolate(corner, exit, fraction);
      rounded.push(interpolate(first, second, fraction));
    }
    rounded.push(exit);
  }
  rounded.push(segment[segment.length - 1]);
  return rounded;
};

const zoomForSpeed = (speed, zoomConfig = {}) => {
  const {
    autoZoom = true,
    minSpeed = 0,
    maxSpeed = 120,
    maxZoom = 16,
    minZoom = 10
  } = zoomConfig;
  if (!autoZoom) return maxZoom;
  const value = Number(speed);
  if (!Number.isFinite(value) || value <= minSpeed) return maxZoom;
  if (value >= maxSpeed) return minZoom;
  return Math.round(maxZoom - ((value - minSpeed) / (maxSpeed - minSpeed)) * (maxZoom - minZoom));
};

const MapViewport = ({ points, speed, zoomConfig, followLatest = false }) => {
  const map = useMap();

  useEffect(() => {
    if (points.length === 1 || followLatest) map.setView(points[points.length - 1], zoomForSpeed(speed, zoomConfig));
    else if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 15 });
  }, [followLatest, map, points, speed, zoomConfig]);

  return null;
};

const MAP_TILES = {
  standard: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },
  night: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },
  dark: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri'
  }
};

export const mapAttributionLabel = (mapTheme) => {
  // Older saved "dark" overlays deliberately render with the dependable
  // Night filter until an API-backed dark provider is introduced.
  if (mapTheme === 'dark') return '© OpenStreetMap contributors';
  if (mapTheme === 'satellite') return 'Tiles © Esri';
  return '© OpenStreetMap contributors';
};

const GpsMap = ({ positions = [], mapTheme = 'standard', size, zoomConfig, connectPoints = true, showHistoryMarkers = true, fadingTrail = false, roundedCorners = false, followLatest = false, zoomControl = true, attributionControl = true, mapOpacity = 100 }) => {
  const validPositions = positions.filter((position) => (
    Number.isFinite(Number(position.latitude)) && Number.isFinite(Number(position.longitude))
  ));
  const points = validPositions.map((position) => [Number(position.latitude), Number(position.longitude)]);
  const latestPosition = validPositions[validPositions.length - 1];
  const routeSegments = validPositions.reduce((segments, position) => {
    if (position.route_break_before || !segments.length) segments.push([]);
    segments[segments.length - 1].push([Number(position.latitude), Number(position.longitude)]);
    return segments;
  }, []);
  const markerPositions = showHistoryMarkers ? validPositions : (latestPosition ? [latestPosition] : []);
  const renderedRouteSegments = roundedCorners ? routeSegments.map(roundedSegment) : routeSegments;
  // Legacy CARTO/Esri dark selections are retained in saved overlays, but use
  // the dependable Night rendering until a configured API-backed provider is
  // introduced.
  const effectiveTheme = mapTheme === 'dark' ? 'night' : mapTheme;
  const tiles = MAP_TILES[effectiveTheme] || MAP_TILES.standard;
  const mapClass = effectiveTheme === 'night' ? 'gps-map__leaflet--night' : '';

  return (
    <div className="gps-map" style={size ? { '--gps-map-size': `${size}px` } : undefined} aria-label="GPS map">
      <MapContainer
        key={effectiveTheme}
        center={points[0] || DEFAULT_CENTER}
        className={mapClass}
        zoom={points.length ? 14 : 6}
        zoomControl={zoomControl}
        attributionControl={attributionControl}
        scrollWheelZoom
      >
        <TileLayer
          attribution={tiles.attribution}
          opacity={Math.max(0.1, Math.min(1, Number(mapOpacity) / 100))}
          url={tiles.url}
        />
        <MapViewport points={points} speed={latestPosition?.speed} zoomConfig={zoomConfig} followLatest={followLatest} />
        {connectPoints && !fadingTrail && renderedRouteSegments.map((segment, index) => segment.length > 1 && <Polyline key={`route-${index}`} positions={segment} pathOptions={{ color: '#0b6bcb', weight: 4, lineCap: 'round', lineJoin: 'round' }} />)}
        {connectPoints && fadingTrail && routeSegments.flatMap((segment, segmentIndex) => segment.slice(1).map((point, pointIndex) => {
          const progress = (pointIndex + 1) / Math.max(1, segment.length - 1);
          return <Polyline key={`trail-${segmentIndex}-${pointIndex}`} positions={[segment[pointIndex], point]} pathOptions={{ color: '#53b1fd', weight: 5, opacity: 0.08 + progress * 0.82, lineCap: 'round', lineJoin: 'round' }} />;
        }))}
        {markerPositions.map((position, index) => {
          const point = [Number(position.latitude), Number(position.longitude)];
          const isLatest = position === latestPosition;
          return (
            <CircleMarker
              center={point}
              key={`${position.recorded_at}-${point[0]}-${point[1]}-${index}`}
              pathOptions={{ color: isLatest ? '#067647' : '#0b6bcb', fillColor: isLatest ? '#12b76a' : '#53b1fd', fillOpacity: 0.95 }}
              radius={isLatest ? 9 : 5}
            >
              <Popup>
                <strong>{position.name || (isLatest ? 'Latest position' : 'GPS position')}</strong><br />
                {point[0]}, {point[1]}<br />
                {position.recorded_at ? new Date(position.recorded_at).toLocaleString() : 'Time not reported'}
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
      {!points.length && <p className="gps-map__empty">No GPS positions have been received yet.</p>}
    </div>
  );
};

export default GpsMap;
