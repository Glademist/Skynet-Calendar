// src/ApprovalPending.js
import React from 'react';
import { auth } from './firebase';
import { signOut } from 'firebase/auth';
import './ApprovalPending.css';   // můžeš vytvořit později

export default function ApprovalPending({ user }) {
  const handleLogout = () => {
    signOut(auth);
  };

  return (
    <div className="approval-pending-container">
      <div className="approval-card">
        <div className="approval-icon">⏳</div>
        
        <h1>Účet čeká na schválení</h1>
        
        <p>
          Ahoj {user?.given_name || user?.name},<br/>
          váš účet byl úspěšně vytvořen, ale ještě nebyl schválen administrátorem.
        </p>

        <div className="approval-info">
          <strong>Co teď?</strong><br/>
          Administrátor (Alexandr) vás musí schválit. Jakmile to udělá, budete moci plánovat služby.
        </div>

        <button onClick={handleLogout} className="approval-logout-btn">
          Odhlásit se
        </button>

        <p className="approval-small">
          Po schválení se stačí znovu přihlásit.
        </p>
      </div>
    </div>
  );
}