import React from 'react';
import { auth, googleProvider } from './firebase';
import { signInWithPopup } from 'firebase/auth';
import './styles/login.css';

export default function Login({ onLogin }) {
  const handleGoogle = () => {
    signInWithPopup(auth, googleProvider)
      .then(result => onLogin(result.user))
      .catch(err => alert(err.message));
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