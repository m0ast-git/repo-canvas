import { useCallback, useEffect, useRef, useState } from "react";
import { layoutFingerprint } from "./layout-fingerprint.js";
import { LAYOUT_VERSION } from "./container-layout.js";

// Layout supplies rectangles and logical edges. Only present-routes owns final
// routing; pointer motion stays local and never queues a second router.
export function useCanvasLayout(snapshot) {
  const positions = JSON.stringify([...snapshot.areas, ...snapshot.entities, ...snapshot.work].map(item => [item.id, item.x, item.y]));
  const key = `${snapshot._history?.id || "live"}:${layoutFingerprint(snapshot)}:${positions}`;
  const activeKey = useRef(key); activeKey.current = key;
  const [state, setState] = useState({ key: null, layout: null, settled: false });
  const [presentation, setPresentation] = useState({ key: null, routes: [], seq: 0 });
  const requested = useRef({ key: null, seq: 0 });
  const worker = useRef(null);
  const arrangement=useRef(null);
  const arrangementSequence=useRef(0);
  const request = useRef(0);
  useEffect(() => {
    const instance = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
    worker.current = instance;
    instance.onmessage = ({ data }) => {
      if(data.type==="arranged") {const pending=arrangement.current;if(!pending||pending.id!==data.id)return;arrangement.current=null;if(data.ok)pending.resolve(data.result);else pending.reject(new Error(data.error));return;}
      if (data.type === "presented-routes") {
        if (data.seq !== requested.current.seq || data.key !== requested.current.key || data.layoutKey !== activeKey.current) return;
        if (data.error) console.error(data.error);
        setPresentation(data); return;
      }
      if (data.id !== request.current || data.layoutKey !== activeKey.current) return;
      if (data.ok) setState({ key: data.layoutKey, layout: { ...data.result, revision: data.id }, settled: true });
      else console.error(data.error);
    };
    return () => { instance.terminate(); worker.current = null;arrangement.current?.reject(new Error("Карта закрыта"));arrangement.current=null; };
  }, []);
  useEffect(() => {
    if(arrangement.current){arrangement.current.reject(new Error("Карта изменилась во время упорядочивания"));arrangement.current=null;}
    request.current += 1;
    requested.current = { key: null, seq: requested.current.seq + 1 };
    const saved = snapshot._geometry;
    if (snapshot._history && saved) {
      setState({ key, layout: { ...saved, revision: request.current }, settled: true });
      return;
    }
    setState(previous => ({ key, layout: snapshot._history ? null : saved?.layoutVersion === LAYOUT_VERSION ? { ...saved, revision: request.current } : previous.layout, settled: false }));
    worker.current?.postMessage({ type: "layout", id: request.current, layoutKey: key, snapshot });
  }, [key]);
  const prepareRoutes = useCallback((routingKey, routes, scene) => {
    if (!worker.current || requested.current.key === routingKey) return;
    const seq = requested.current.seq + 1;
    requested.current = { key: routingKey, seq };
    worker.current.postMessage({ type: "present-routes", key: routingKey, layoutKey: activeKey.current, seq, routes, scene });
  }, []);
  const layout = snapshot._history && state.key !== key ? null : state.layout;
  const arrange=useCallback(()=>new Promise((resolve,reject)=>{if(arrangement.current||!worker.current){reject(new Error("Раскладка уже рассчитывается"));return;}const id=++arrangementSequence.current;arrangement.current={id,resolve,reject};worker.current.postMessage({type:"arrange",id,snapshot:{...snapshot,_geometry:undefined,_layoutSeed:undefined}});}),[snapshot]);
  return { layout, settled: state.key === key && state.settled, routes: layout?.routes || [], prepareRoutes, presentation,arrange };
}
