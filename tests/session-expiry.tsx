import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/shared/model/store";
import { api, isMobile } from "../src/shared/api/api";
import Profile from "../src/features/account/Profile";
import SessionNotice from "../src/features/account/SessionNotice";
import LoginModal from "../src/features/account/LoginModal";
import "../src/index.css";

function Probe() {
  const store = useStore();
  useEffect(() => { Object.assign(window, { sessionExpiryStore: store, sessionExpiryApi: api }); }, [store]);
  return <><Profile wide={!isMobile} /><SessionNotice /><LoginModal /></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><AppProvider><Probe /></AppProvider></React.StrictMode>);
