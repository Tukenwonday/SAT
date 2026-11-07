import React from 'react';
import { MAINTENANCE_TITLE, MAINTENANCE_MESSAGE } from '../siteConfig';

export default function MaintenanceScreen() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
        background: '#f5f6fa',
        color: '#111827',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        zIndex: 9999,
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 800 }}>{MAINTENANCE_TITLE}</div>
      <div style={{ fontSize: 15, color: '#6b7280', maxWidth: 380 }}>{MAINTENANCE_MESSAGE}</div>
    </div>
  );
}

