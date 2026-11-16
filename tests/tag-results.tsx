import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/store";
import { TagPage } from "../src/pages/Discover";
import "../src/index.css";

function Fixture() {
  const [tag, setTag] = useState({ slug: "first-tag", name: "标签甲" });
  const store = useStore();
  useEffect(() => { Object.assign(window, { tagResultsStore: store, selectTag: setTag }); }, [store]);
  return <div style={{ position: "relative", width: 390, height: 844 }}>
    <TagPage tag={tag.slug} name={tag.name} wide={false} onBack={() => {}} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<AppProvider><Fixture /></AppProvider>);
