import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/store";
import { api, isMobile } from "../src/api";
import Profile from "../src/pages/Profile";
import SessionNotice from "../src/components/SessionNotice";
import LoginModal from "../src/components/LoginModal";
import "../src/index.css";

function Probe() {
  const store = useStore();
  useEffect(() => { Object.assign(window, { sessionExpiryStore: store, sessionExpiryApi: api }); }, [store]);
  return <><Profile wide={!isMobile} /><SessionNotice /><LoginModal /></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><AppProvider><Probe /></AppProvider></React.StrictMode>);
