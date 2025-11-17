import React from 'react';
import { auth, googleProvider } from './firebase';
import { signInWithPopup } from 'firebase/auth';
import './styles/login.css';

export default function Login() {
  const handleGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      // Firebase auth listener v App.js už to zachytí → nic dalšího není potřeba
    } catch (err) {
      alert('Přihlášení selhalo: ' + err.message);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-title">Skynet – služby</h1>
        <button className="google-btn" onClick={handleGoogle}>
          <img src="https://www.google.com/favicon.ico" alt="Google" className="google-icon" />
          Přihlásit přes Google
        </button>
      </div>
    </div>
  );
}