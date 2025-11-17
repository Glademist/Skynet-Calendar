import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { GoogleAuthProvider, getAuth } from "firebase/auth";
// Import the functions you need from the SDKs you need
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC9CnVg6yuN7hz8V6raiK11fNn9u6h1AQQ",
  authDomain: "skynet-bba3f.firebaseapp.com",
  projectId: "skynet-bba3f",
  storageBucket: "skynet-bba3f.firebasestorage.app",
  messagingSenderId: "536378529534",
  appId: "1:536378529534:web:f7c925c29ec5889743b7af"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();