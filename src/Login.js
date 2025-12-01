// src/Login.js
import React from 'react';
import { auth, googleProvider } from './firebase';
import { signInWithPopup } from 'firebase/auth';
import "./Login.css"

export default function Login() {
  const handleGoogle = () => {
    signInWithPopup(auth, googleProvider).catch(err => {
      window.notify('Přihlášení selhalo: ' + err.message, 'error');
    });
  };

  return (
    <div className="log-loginContainer">
      <div className="log-loginCard">
        <h1 className="log-loginTitle">Skynet – služby</h1>
        <button className="log-googleBtn" onClick={handleGoogle}>
          <img src="https://www.google.com/favicon.ico" alt="Google" className="log-googleIcon" />
          Přihlásit přes Google
        </button>
      </div>
    </div>
  );
}