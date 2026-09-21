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

const MapViewport = ({ points, speed, zoomConfig }) => {
  const map = useMap();

  useEffect(() => {
    if (points.length === 1) map.setView(points[0], zoomForSpeed(speed, zoomConfig));
    if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 15 });
  }, [map, points, speed, zoomConfig]);

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
    // Browser requests go through our cacheable proxy. Some client networks
    // receive an "API KEY REQUIRED" image from CARTO's legacy public endpoint
    // even though the tile is available server-to-server.
    url: '/api/v1/map-tiles/carto/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri'
  }
};

export const mapAttributionLabel = (mapTheme) => {
  if (mapTheme === 'satellite') return 'Tiles © Esri';
  if (mapTheme === 'dark') return '© OpenStreetMap contributors © CARTO';
  return '© OpenStreetMap contributors';
};

const GpsMap = ({ positions = [], mapTheme = 'standard', size, zoomConfig, connectPoints = true, zoomControl = true, attributionControl = true, mapOpacity = 100 }) => {
  const validPositions = positions.filter((position) => (
    Number.isFinite(Number(position.latitude)) && Number.isFinite(Number(position.longitude))
  ));
  const points = validPositions.map((position) => [Number(position.latitude), Number(position.longitude)]);
  const latestPosition = validPositions[validPositions.length - 1];
  const tiles = MAP_TILES[mapTheme] || MAP_TILES.standard;

  return (
    <div className="gps-map" style={size ? { '--gps-map-size': `${size}px` } : undefined} aria-label="GPS map">
      <MapContainer
        center={points[0] || DEFAULT_CENTER}
        className={mapTheme === 'night' ? 'gps-map__leaflet--night' : ''}
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
        <MapViewport points={points} speed={latestPosition?.speed} zoomConfig={zoomConfig} />
        {connectPoints && points.length > 1 && <Polyline positions={points} pathOptions={{ color: '#0b6bcb', weight: 4 }} />}
        {points.map((point, index) => {
          const position = validPositions[index];
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
