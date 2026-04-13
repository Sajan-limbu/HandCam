import {
  FilesetResolver,
  HandLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const {
  Deck,
  TileLayer,
  BitmapLayer
} = globalThis.deck || {};

const ITAHARI_CENTER = [87.2718, 26.663];
const ITAHARI_BOUNDS = {
  west: 87.228,
  east: 87.322,
  south: 26.628,
  north: 26.695
};

const INITIAL_VIEW_STATE = {
  longitude: ITAHARI_CENTER[0],
  latitude: ITAHARI_CENTER[1],
  zoom: 13.9,
  pitch: 52,
  bearing: 18,
  maxZoom: 17.5,
  minZoom: 12.8
};

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

const mapRoot = document.querySelector("#mapRoot");
const loadMapButton = document.querySelector("#loadMapButton");
const startCameraButton = document.querySelector("#startCameraButton");
const toggleCameraButton = document.querySelector("#toggleCameraButton");
const recenterButton = document.querySelector("#recenterButton");
const webcam = document.querySelector("#webcam");
const gestureCanvas = document.querySelector("#gestureCanvas");
const gestureContext = gestureCanvas.getContext("2d");
const mapStatus = document.querySelector("#mapStatus");
const gestureStatus = document.querySelector("#gestureStatus");
const cameraStatus = document.querySelector("#cameraStatus");
const headingValue = document.querySelector("#headingValue");
const tiltValue = document.querySelector("#tiltValue");
const zoomValue = document.querySelector("#zoomValue");
const cameraDot = document.querySelector("#cameraDot");

let deckInstance = null;
let handLandmarker = null;
let predictionFrame = null;
let activeStream = null;

const gestureState = {
  pointerPoint: null,
  twoHandDistance: null,
  panPoint: null,
  smoothedPoint: null,
  smoothedDistance: null,
  smoothedPanPoint: null
};

let viewState = {...INITIAL_VIEW_STATE};
let continuousMotion = {
  bearingVelocity: 0,
  pitchVelocity: 0,
  panXVelocity: 0,
  panYVelocity: 0
};

function setStatus(element, value) {
  element.textContent = value;
}

function setCameraLive(isLive) {
  cameraDot.classList.toggle("live", isLive);
  toggleCameraButton.textContent = isLive ? "Camera off" : "Camera on";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function constrainViewState(nextViewState) {
  return {
    ...nextViewState,
    longitude: clamp(nextViewState.longitude, ITAHARI_BOUNDS.west, ITAHARI_BOUNDS.east),
    latitude: clamp(nextViewState.latitude, ITAHARI_BOUNDS.south, ITAHARI_BOUNDS.north),
    zoom: clamp(nextViewState.zoom, INITIAL_VIEW_STATE.minZoom, INITIAL_VIEW_STATE.maxZoom),
    pitch: clamp(nextViewState.pitch, 28, 68),
    bearing: ((nextViewState.bearing % 360) + 360) % 360
  };
}

function updateTelemetry() {
  headingValue.textContent = `${Math.round(viewState.bearing)}deg`;
  tiltValue.textContent = `${Math.round(viewState.pitch)}deg`;
  zoomValue.textContent = `z${viewState.zoom.toFixed(1)}`;
}

function showPlaceholder(message, detail = "") {
  mapRoot.innerHTML = `
    <div class="map-placeholder">
      <div>
        <strong>${message}</strong>
        <div>${detail}</div>
      </div>
    </div>
  `;
}

function buildLayers() {
  return [
    new TileLayer({
      id: "osm-tiles",
      data: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: (props) => {
        const {
          bbox: {west, south, east, north}
        } = props.tile;

        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [west, south, east, north]
        });
      }
    })
  ];
}

function loadDeckMap() {
  if (!Deck || !TileLayer || !BitmapLayer) {
    setStatus(mapStatus, "deck.gl failed to load");
    showPlaceholder(
      "Map library failed to load",
      "Refresh the page once. If it still fails, open the browser console and share the error."
    );
    return;
  }

  mapRoot.innerHTML = "";

  if (deckInstance) {
    deckInstance.finalize();
  }

  deckInstance = new Deck({
    parent: mapRoot,
    controller: {
      dragRotate: true,
      doubleClickZoom: true,
      scrollZoom: true,
      touchRotate: true,
      touchZoom: true
    },
    initialViewState: viewState,
    viewState,
    layers: buildLayers(),
    getTooltip: ({object}) => object?.name ? {text: object.name} : null,
    onViewStateChange: ({viewState: nextViewState}) => {
      viewState = constrainViewState(nextViewState);
      deckInstance.setProps({viewState});
      updateTelemetry();
    }
  });

  setStatus(mapStatus, "Itahari map live");
  updateTelemetry();
}

function recenterMap() {
  viewState = {...INITIAL_VIEW_STATE};
  if (deckInstance) {
    deckInstance.setProps({viewState});
  }
  updateTelemetry();
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isFingerExtended(landmarks, tipIndex, pipIndex) {
  return landmarks[tipIndex].y < landmarks[pipIndex].y;
}

function isOpenHand(landmarks) {
  const indexExtended = isFingerExtended(landmarks, 8, 6);
  const middleExtended = isFingerExtended(landmarks, 12, 10);
  const ringExtended = isFingerExtended(landmarks, 16, 14);
  const pinkyExtended = isFingerExtended(landmarks, 20, 18);
  return indexExtended && middleExtended && ringExtended && pinkyExtended;
}

function detectGesture(landmarks) {
  const indexExtended = isFingerExtended(landmarks, 8, 6);
  const middleExtended = isFingerExtended(landmarks, 12, 10);
  const ringExtended = isFingerExtended(landmarks, 16, 14);
  const pinkyExtended = isFingerExtended(landmarks, 20, 18);

  if (indexExtended && middleExtended && !ringExtended && !pinkyExtended) {
    return {
      name: "pan",
      point: {
        x: (landmarks[8].x + landmarks[12].x) / 2,
        y: (landmarks[8].y + landmarks[12].y) / 2
      }
    };
  }

  if (indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
    return {
      name: "point",
      point: {x: landmarks[9].x, y: landmarks[9].y}
    };
  }

  return {name: "idle"};
}

function smoothPoint(point) {
  if (!gestureState.smoothedPoint) {
    gestureState.smoothedPoint = {...point};
    return gestureState.smoothedPoint;
  }

  gestureState.smoothedPoint.x = lerp(gestureState.smoothedPoint.x, point.x, 0.13);
  gestureState.smoothedPoint.y = lerp(gestureState.smoothedPoint.y, point.y, 0.13);
  return gestureState.smoothedPoint;
}

function smoothPanPoint(point) {
  if (!gestureState.smoothedPanPoint) {
    gestureState.smoothedPanPoint = {...point};
    return gestureState.smoothedPanPoint;
  }

  gestureState.smoothedPanPoint.x = lerp(gestureState.smoothedPanPoint.x, point.x, 0.16);
  gestureState.smoothedPanPoint.y = lerp(gestureState.smoothedPanPoint.y, point.y, 0.16);
  return gestureState.smoothedPanPoint;
}

function smoothDistance(value) {
  if (gestureState.smoothedDistance === null) {
    gestureState.smoothedDistance = value;
    return gestureState.smoothedDistance;
  }

  gestureState.smoothedDistance = lerp(gestureState.smoothedDistance, value, 0.2);
  return gestureState.smoothedDistance;
}

function resetGestureState() {
  gestureState.pointerPoint = null;
  gestureState.twoHandDistance = null;
  gestureState.panPoint = null;
  gestureState.smoothedPoint = null;
  gestureState.smoothedDistance = null;
  gestureState.smoothedPanPoint = null;
  continuousMotion.bearingVelocity = 0;
  continuousMotion.pitchVelocity = 0;
  continuousMotion.panXVelocity = 0;
  continuousMotion.panYVelocity = 0;
}

function resizeGestureCanvas() {
  const rect = gestureCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  gestureCanvas.width = Math.round(rect.width * ratio);
  gestureCanvas.height = Math.round(rect.height * ratio);
  gestureContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawLandmarks(landmarks, gestureName) {
  const width = gestureCanvas.clientWidth;
  const height = gestureCanvas.clientHeight;
  gestureContext.lineWidth = 2;
  gestureContext.strokeStyle = "rgba(121, 187, 255, 0.82)";
  gestureContext.fillStyle = gestureName === "zoom" ? "#f2c56f" : "#64e5d2";

  for (const [from, to] of HAND_CONNECTIONS) {
    gestureContext.beginPath();
    gestureContext.moveTo(landmarks[from].x * width, landmarks[from].y * height);
    gestureContext.lineTo(landmarks[to].x * width, landmarks[to].y * height);
    gestureContext.stroke();
  }

  for (const landmark of landmarks) {
    gestureContext.beginPath();
    gestureContext.arc(landmark.x * width, landmark.y * height, 4.4, 0, Math.PI * 2);
    gestureContext.fill();
  }
}

function clearGestureOverlay() {
  gestureContext.clearRect(0, 0, gestureCanvas.clientWidth, gestureCanvas.clientHeight);
}

function computeEdgeVelocity(point) {
  const edgeThreshold = 0.18;
  const leftZone = point.x < edgeThreshold ? (edgeThreshold - point.x) / edgeThreshold : 0;
  const rightZone = point.x > 1 - edgeThreshold ? (point.x - (1 - edgeThreshold)) / edgeThreshold : 0;
  const topZone = point.y < edgeThreshold ? (edgeThreshold - point.y) / edgeThreshold : 0;
  const bottomZone = point.y > 1 - edgeThreshold ? (point.y - (1 - edgeThreshold)) / edgeThreshold : 0;

  continuousMotion.bearingVelocity = (leftZone - rightZone) * 1.8;
  continuousMotion.pitchVelocity = (bottomZone - topZone) * 1.25;
  continuousMotion.panXVelocity = 0;
  continuousMotion.panYVelocity = 0;
}

function computePanEdgeVelocity(point) {
  const edgeThreshold = 0.18;
  const leftZone = point.x < edgeThreshold ? (edgeThreshold - point.x) / edgeThreshold : 0;
  const rightZone = point.x > 1 - edgeThreshold ? (point.x - (1 - edgeThreshold)) / edgeThreshold : 0;
  const topZone = point.y < edgeThreshold ? (edgeThreshold - point.y) / edgeThreshold : 0;
  const bottomZone = point.y > 1 - edgeThreshold ? (point.y - (1 - edgeThreshold)) / edgeThreshold : 0;

  continuousMotion.bearingVelocity = 0;
  continuousMotion.pitchVelocity = 0;
  continuousMotion.panXVelocity = (rightZone - leftZone) * 0.0022;
  continuousMotion.panYVelocity = (topZone - bottomZone) * 0.0015;
}

function applyContinuousMotion() {
  if (!deckInstance) {
    return;
  }

  if (
    continuousMotion.bearingVelocity === 0 &&
    continuousMotion.pitchVelocity === 0 &&
    continuousMotion.panXVelocity === 0 &&
    continuousMotion.panYVelocity === 0
  ) {
    return;
  }

  const panScale = 0.012 / Math.max(viewState.zoom - 11, 1);
  viewState = constrainViewState({
    ...viewState,
    bearing: viewState.bearing + continuousMotion.bearingVelocity,
    pitch: viewState.pitch + continuousMotion.pitchVelocity,
    longitude: viewState.longitude + continuousMotion.panXVelocity * panScale * 18,
    latitude: viewState.latitude + continuousMotion.panYVelocity * panScale * 12
  });
  deckInstance.setProps({viewState});
  updateTelemetry();
}

function applyGestureToMap(landmarksList) {
  if (!deckInstance) {
    setStatus(gestureStatus, "Load the map first");
    return;
  }

  gestureContext.clearRect(0, 0, gestureCanvas.clientWidth, gestureCanvas.clientHeight);

  if (landmarksList.length >= 2) {
    const firstHandOpen = isOpenHand(landmarksList[0]);
    const secondHandOpen = isOpenHand(landmarksList[1]);
    const firstGesture = detectGesture(landmarksList[0]);
    const secondGesture = detectGesture(landmarksList[1]);

    if (firstHandOpen && secondHandOpen) {
      const pointA = landmarksList[0][9];
      const pointB = landmarksList[1][9];
      const distance = smoothDistance(distance2D(pointA, pointB));
      setStatus(gestureStatus, "Two open hands to zoom");

      if (gestureState.twoHandDistance !== null) {
        const delta = distance - gestureState.twoHandDistance;
        const filteredDelta = Math.abs(delta) < 0.0008 ? 0 : delta;
        viewState = constrainViewState({
          ...viewState,
          zoom: viewState.zoom - filteredDelta * 24
        });
        deckInstance.setProps({viewState});
        updateTelemetry();
      }

      gestureState.twoHandDistance = distance;
      gestureState.pointerPoint = null;
      gestureState.panPoint = null;
      gestureState.smoothedPoint = null;
      continuousMotion.bearingVelocity = 0;
      continuousMotion.pitchVelocity = 0;
      continuousMotion.panXVelocity = 0;
      continuousMotion.panYVelocity = 0;
    } else {
      setStatus(gestureStatus, "Open both hands for zoom");
      gestureState.twoHandDistance = null;
      gestureState.smoothedDistance = null;
    }

    for (const landmarks of landmarksList.slice(0, 2)) {
      drawLandmarks(landmarks, "zoom");
    }
    return;
  }

  if (landmarksList.length === 1) {
    const landmarks = landmarksList[0];
    const gesture = detectGesture(landmarks);

    if (gesture.name === "pan") {
      const point = smoothPanPoint(gesture.point);
      setStatus(gestureStatus, "Two-finger pan");

      if (gestureState.panPoint) {
        const dx = point.x - gestureState.panPoint.x;
        const dy = point.y - gestureState.panPoint.y;
        const filteredDx = Math.abs(dx) < 0.0025 ? 0 : dx;
        const filteredDy = Math.abs(dy) < 0.0025 ? 0 : dy;
        const scale = 0.012 / Math.max(viewState.zoom - 11, 1);

        viewState = constrainViewState({
          ...viewState,
          longitude: viewState.longitude - filteredDx * scale * 18,
          latitude: viewState.latitude - filteredDy * scale * 12
        });
        deckInstance.setProps({viewState});
        updateTelemetry();
      }

      computePanEdgeVelocity(point);
      gestureState.panPoint = {...point};
      gestureState.pointerPoint = null;
      gestureState.twoHandDistance = null;
      gestureState.smoothedPoint = null;
      gestureState.smoothedDistance = null;
    } else if (gesture.name === "point") {
      const point = smoothPoint(gesture.point);
      setStatus(gestureStatus, "Point to rotate");

      if (gestureState.pointerPoint) {
        const dx = point.x - gestureState.pointerPoint.x;
        const dy = point.y - gestureState.pointerPoint.y;
        const filteredDx = Math.abs(dx) < 0.003 ? 0 : dx;
        const filteredDy = Math.abs(dy) < 0.003 ? 0 : dy;
        viewState = constrainViewState({
          ...viewState,
          bearing: viewState.bearing - filteredDx * 72,
          pitch: viewState.pitch + filteredDy * 64
        });
        deckInstance.setProps({viewState});
        updateTelemetry();
      }

      computeEdgeVelocity(point);
      gestureState.pointerPoint = {...point};
      gestureState.twoHandDistance = null;
      gestureState.panPoint = null;
      gestureState.smoothedDistance = null;
      gestureState.smoothedPanPoint = null;
    } else {
      setStatus(gestureStatus, "Use one finger, two fingers, or two hands");
      resetGestureState();
    }

    drawLandmarks(landmarks, gesture.name);
    return;
  }

  setStatus(gestureStatus, "Show hands to begin");
  resetGestureState();
}

async function ensureHandLandmarker() {
  if (handLandmarker) {
    return handLandmarker;
  }

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
    },
    numHands: 2,
    runningMode: "VIDEO"
  });

  return handLandmarker;
}

async function startHandTracking() {
  if (activeStream) {
    return;
  }

  setStatus(cameraStatus, "Requesting permission");

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: {width: 960, height: 720, facingMode: "user"}
    });

    webcam.srcObject = activeStream;
    await webcam.play();
    resizeGestureCanvas();
    setCameraLive(true);
    setStatus(cameraStatus, "Webcam live");
    setStatus(gestureStatus, "Show one or two hands");

    const detector = await ensureHandLandmarker();
    let lastVideoTime = -1;

    const predict = () => {
      if (!activeStream) {
        return;
      }

      applyContinuousMotion();

      if (webcam.readyState >= 2 && webcam.currentTime !== lastVideoTime) {
        lastVideoTime = webcam.currentTime;
        const results = detector.detectForVideo(webcam, performance.now());

        if (results.landmarks.length > 0) {
          applyGestureToMap(results.landmarks);
        } else {
          clearGestureOverlay();
          setStatus(gestureStatus, "Show one or two hands");
          resetGestureState();
        }
      }

      predictionFrame = requestAnimationFrame(predict);
    };

    predict();
  } catch (error) {
    console.error(error);
    activeStream = null;
    setCameraLive(false);
    setStatus(cameraStatus, "Permission denied");
    setStatus(gestureStatus, "Webcam unavailable");
  }
}

function stopHandTracking() {
  if (predictionFrame) {
    cancelAnimationFrame(predictionFrame);
    predictionFrame = null;
  }

  if (activeStream) {
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
  }

  activeStream = null;
  webcam.srcObject = null;
  clearGestureOverlay();
  resetGestureState();
  setCameraLive(false);
  setStatus(cameraStatus, "Camera off");
  setStatus(gestureStatus, "Camera inactive");
}

function toggleCamera() {
  if (activeStream) {
    stopHandTracking();
  } else {
    startHandTracking();
  }
}

loadMapButton.addEventListener("click", () => {
  loadDeckMap();
});

startCameraButton.addEventListener("click", () => {
  startHandTracking();
});

toggleCameraButton.addEventListener("click", () => {
  toggleCamera();
});

recenterButton.addEventListener("click", () => {
  recenterMap();
  setStatus(gestureStatus, deckInstance ? "View recentered" : "Load the map first");
});

window.addEventListener("resize", resizeGestureCanvas);
window.addEventListener("error", (event) => {
  console.error(event.error || event.message);
  if (!deckInstance) {
    setStatus(mapStatus, "Map load failed");
  }
});

resizeGestureCanvas();
setCameraLive(false);
setStatus(mapStatus, "Waiting to load");
setStatus(gestureStatus, "Camera inactive");
setStatus(cameraStatus, "Camera off");
showPlaceholder(
  "Load the Itahari map",
  "This view uses OpenStreetMap tiles and deck.gl rendering, focused only on Itahari, Nepal."
);
updateTelemetry();
loadDeckMap();
