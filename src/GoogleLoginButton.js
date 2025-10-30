// src/GoogleLoginButton.js
import { GoogleLogin } from '@react-oauth/google';

export default function GoogleLoginButton({ onLogin }) {
  const handleSuccess = (response) => {
    const decodeUtf8 = (str) => {
      try {
        return decodeURIComponent(escape(atob(str)));
      } catch (e) {
        return atob(str);
      }
    };

    const payloadBase64 = response.credential.split('.')[1];
    const payload = JSON.parse(decodeUtf8(payloadBase64));

    const user = {
      uid: payload.sub,
      email: payload.email,
      name: payload.name || '',
      given_name: payload.given_name || '',   // ← nové
      family_name: payload.family_name || ''  // ← nové
    };

    localStorage.setItem('user', JSON.stringify(user));
    onLogin(user);
  };

  const handleError = () => {
    alert('Google login selhal. Zkus znovu.');
  };

  return (
    <div style={{ textAlign: 'center', marginTop: '50px' }}>
      <h2>Přihlásit se přes Google</h2>
      <GoogleLogin
        onSuccess={handleSuccess}
        onError={handleError}
        clientId={process.env.REACT_APP_GOOGLE_CLIENT_ID}
      />
    </div>
  );
}