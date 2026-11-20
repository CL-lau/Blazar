import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export function PairingCode({ pairing }) {
  const [address, setAddress] = useState('');
  const [valid, setValid] = useState(false);
  const [expired, setExpired] = useState(false);
  const canvas = useRef(null);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, pairing.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing.expires]);

  useEffect(() => {
    let active = true;
    let endpoint;
    try {
      endpoint = new URL(address.trim());
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
          endpoint.search || endpoint.hash || endpoint.pathname !== '/' || endpoint.href.length > 512) {
        endpoint = undefined;
      }
    } catch { /* Wait for a valid address. */ }
    setValid(false);
    if (endpoint && !expired && canvas.current) {
      QRCode.toCanvas(canvas.current, JSON.stringify({ v: 1, endpoint: endpoint.origin, code: pairing.code }), {
        width: 240, margin: 3, errorCorrectionLevel: 'M',
      }).then(() => { if (active) setValid(true); }).catch(() => {});
    }
    return () => { active = false; };
  }, [address, pairing, expired]);

  if (expired) return <p role="status">This pairing code has expired.</p>;
  return <div>
    <p><code>{pairing.code}</code> · Expires at {new Date(pairing.expires).toLocaleTimeString()}</p>
    <label>Public HTTPS Router address<input type="url" value={address}
      onChange={event => setAddress(event.target.value)} placeholder="https://blazar.example.com" /></label>
    <canvas ref={canvas} hidden={!valid} aria-label="Scan to pair iPhone" />
  </div>;
}
