import React, { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const DEFAULT_CENTER = [52.2297, 21.0122];
const OPEN_FREE_MAP_DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';

const zoomForSpeed = (speed, zoomConfig = {}) => {
  const { autoZoom = true, minSpeed = 0, maxSpeed = 120, maxZoom = 16, minZoom = 10 } = zoomConfig;
  if (!autoZoom) return maxZoom;
  const value = Number(speed);
  if (!Number.isFinite(value) || value <= minSpeed) return maxZoom;
  if (value >= maxSpeed) return minZoom;
  return Math.round(maxZoom - ((value - minSpeed) / (maxSpeed - minSpeed)) * (maxZoom - minZoom));
};

const DarkVectorMap = ({ points, speed, zoomConfig, connectPoints, zoomControl, attributionControl, mapOpacity }) => {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OPEN_FREE_MAP_DARK_STYLE,
      center: points[0] ? [points[0][1], points[0][0]] : [DEFAULT_CENTER[1], DEFAULT_CENTER[0]],
      zoom: points.length ? 14 : 6,
      attributionControl: false
    });
    if (zoomControl) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    if (attributionControl) map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    mapRef.current = map;
    return () => { observer.disconnect(); map.remove(); mapRef.current = null; };
  }, [attributionControl, zoomControl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const update = () => {
      const features = points.map((point, index) => ({ type: 'Feature', properties: { latest: index === points.length - 1 }, geometry: { type: 'Point', coordinates: [point[1], point[0]] } }));
      const sourceData = { type: 'FeatureCollection', features };
      if (!map.getSource('stream-gps-positions')) {
        map.addSource('stream-gps-positions', { type: 'geojson', data: sourceData });
        if (connectPoints) map.addLayer({ id: 'stream-gps-route', type: 'line', source: 'stream-gps-positions', paint: { 'line-color': '#2387ef', 'line-width': 4 } });
        map.addLayer({ id: 'stream-gps-points', type: 'circle', source: 'stream-gps-positions', paint: { 'circle-radius': ['case', ['get', 'latest'], 9, 5], 'circle-color': ['case', ['get', 'latest'], '#12b76a', '#53b1fd'], 'circle-stroke-color': ['case', ['get', 'latest'], '#067647', '#0b6bcb'], 'circle-stroke-width': 2 } });
      } else map.getSource('stream-gps-positions').setData(sourceData);
      if (points.length === 1) { map.setCenter([points[0][1], points[0][0]]); map.setZoom(zoomForSpeed(speed, zoomConfig)); }
      if (points.length > 1) {
        const bounds = points.reduce((value, point) => value.extend([point[1], point[0]]), new maplibregl.LngLatBounds([points[0][1], points[0][0]], [points[0][1], points[0][0]]));
        map.fitBounds(bounds, { padding: 32, maxZoom: 15 });
      }
    };
    if (map.isStyleLoaded()) update(); else map.once('load', update);
    return () => map.off('load', update);
  }, [connectPoints, points, speed, zoomConfig]);

  return <div ref={containerRef} className="gps-map__vector" style={{ opacity: Math.max(0.1, Math.min(1, Number(mapOpacity) / 100)) }} aria-label="GPS dark map" />;
};

export default DarkVectorMap;
