// src/NotificationBar.js
import React, { useState, useEffect } from 'react';
import './NotificationBar.css';

export default function NotificationBar() {
  const [msg, setMsg] = useState('');
  const [type, setType] = useState(''); // 'success', 'error', 'info'

  useEffect(() => {
    const handler = (e) => {
      setMsg(e.detail.msg);
      setType(e.detail.type);
      setTimeout(() => {
        setMsg('');
        setType('');
      }, 5000);
    };
    window.addEventListener('notify', handler);
    return () => window.removeEventListener('notify', handler);
  }, []);

  if (!msg) return null;

  return (
    <div className={`notification-bar ${type}`}>
      {msg}
    </div>
  );
}

// Funkce pro volání odkudkoliv
window.notify = (msg, type = 'info') => {
  window.dispatchEvent(new CustomEvent('notify', { detail: { msg, type } }));
};