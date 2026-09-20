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

const MapViewport = ({ points }) => {
  const map = useMap();

  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 15);
    if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 15 });
  }, [map, points]);

  return null;
};

const GpsMap = ({ positions = [] }) => {
  const validPositions = positions.filter((position) => (
    Number.isFinite(Number(position.latitude)) && Number.isFinite(Number(position.longitude))
  ));
  const points = validPositions.map((position) => [Number(position.latitude), Number(position.longitude)]);
  const latestPosition = validPositions[validPositions.length - 1];

  return (
    <div className="gps-map" aria-label="GPS map">
      <MapContainer center={points[0] || DEFAULT_CENTER} zoom={points.length ? 14 : 6} scrollWheelZoom>
        <TileLayer
          attribution={'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapViewport points={points} />
        {points.length > 1 && <Polyline positions={points} pathOptions={{ color: '#0b6bcb', weight: 4 }} />}
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
                <strong>{isLatest ? 'Latest position' : 'GPS position'}</strong><br />
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
