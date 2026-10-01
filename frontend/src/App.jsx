import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";

const socket = io(
  import.meta.env.VITE_SOCKET_URL ||
    "https://syncsound-h34k.onrender.com"
);
function App() {
  const [roomId, setRoomId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("Not connected");
  const [qrRoom, setQrRoom] = useState("");

  // 📊 WebRTC diagnostic stats
  const [stats, setStats] = useState({
    rtt: "-",
    jitter: "-",
    packetsLost: "-",
    jitterBuffer: "-",
  });

  // 🔒 Wake Lock status
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const audioRef = useRef(null);

  // Important: keep current room in a ref
  const roomIdRef = useRef("");

  // ICE candidates can arrive before remote description
  const pendingCandidates = useRef([]);

  // 🔒 Wake Lock object
  const wakeLockRef = useRef(null);

  // 📊 Previous WebRTC stats
  const previousStatsRef = useRef({
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    packetsLost: 0,
  });

  // Prevent multiple recovery attempts at once
  const audioRecoveryInProgress = useRef(false);

  // 🔄 WebRTC reconnect control
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  // 🎵 Keep the latest remote stream so audio can be re-attached after recovery
  const remoteStreamRef = useRef(null);

  // --------------------------------------------------
  // 🔒 REQUEST SCREEN WAKE LOCK
  // --------------------------------------------------

  const requestWakeLock = async () => {
    try {
      if (!("wakeLock" in navigator)) {
        console.log("⚠️ Wake Lock API not supported");
        setWakeLockActive(false);
        return;
      }

      if (wakeLockRef.current) {
        console.log("🔒 Wake Lock already active");
        return;
      }

      const lock = await navigator.wakeLock.request("screen");

      wakeLockRef.current = lock;
      setWakeLockActive(true);

      console.log("🔒 SyncSound Wake Lock enabled");

      lock.addEventListener("release", () => {
        console.log("🔓 Wake Lock released");

        wakeLockRef.current = null;
        setWakeLockActive(false);
      });
    } catch (error) {
      console.error("❌ Wake Lock error:", error);
      setWakeLockActive(false);
    }
  };

  // --------------------------------------------------
  // 🔓 RELEASE WAKE LOCK
  // --------------------------------------------------

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();

        wakeLockRef.current = null;
        setWakeLockActive(false);

        console.log("🔓 Wake Lock manually released");
      }
    } catch (error) {
      console.error("❌ Wake Lock release error:", error);
    }
  };

  // --------------------------------------------------
  // 🎵 MEDIA SESSION
  // --------------------------------------------------

  const setupMediaSession = () => {
    if (!("mediaSession" in navigator)) {
      console.log("⚠️ Media Session API not supported");
      return;
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "SyncSound",
        artist: "Wireless Speaker",
        album: "SyncSound",
      });

      navigator.mediaSession.playbackState = "playing";

      navigator.mediaSession.setActionHandler("play", async () => {
        console.log("▶️ Media Session play");

        if (audioRef.current) {
          try {
            await audioRef.current.play();
            navigator.mediaSession.playbackState = "playing";
          } catch (error) {
            console.error("❌ Media Session play error:", error);
          }
        }
      });

      navigator.mediaSession.setActionHandler("pause", () => {
        console.log("⏸️ Media Session pause");

        if (audioRef.current) {
          audioRef.current.pause();
          navigator.mediaSession.playbackState = "paused";
        }
      });

      console.log("🎵 Media Session configured");
    } catch (error) {
      console.error("❌ Media Session setup error:", error);
    }
  };

  // --------------------------------------------------
  // 🔊 AUDIO PLAYBACK RECOVERY
  // --------------------------------------------------

  const recoverAudioPlayback = async () => {
    const audio = audioRef.current;

    if (!audio) {
      console.log("⚠️ No audio element available");
      return;
    }

    if (audioRecoveryInProgress.current) {
      return;
    }

    audioRecoveryInProgress.current = true;

    try {
      console.log("🔄 Attempting audio playback recovery...");

      // Re-attach the latest remote stream if the audio element lost it.
      if (
        remoteStreamRef.current &&
        audio.srcObject !== remoteStreamRef.current
      ) {
        audio.srcObject = remoteStreamRef.current;
        audio.load();
      }

      if (audio.paused) {
        await audio.play();

        console.log("🔊 Audio playback recovered");

        if ("mediaSession" in navigator) {
          navigator.mediaSession.playbackState = "playing";
        }
      } else {
        console.log("🔊 Audio is already playing");
      }
    } catch (error) {
      console.log(
        "⚠️ Browser requires user interaction to resume audio:",
        error
      );
    } finally {
      audioRecoveryInProgress.current = false;
    }
  };

  // --------------------------------------------------
  // 📱 VISIBILITY / SCREEN STATE
  // --------------------------------------------------

  useEffect(() => {
    const handleVisibilityChange = async () => {
      console.log(
        "👀 Visibility changed:",
        document.visibilityState
      );

      if (
        document.visibilityState === "visible" &&
        role === "phone"
      ) {
        console.log("📱 Phone page visible again");

        // Wake Lock may have been released while hidden
        if (!wakeLockRef.current) {
          await requestWakeLock();
        }

        // Try to resume audio
        await recoverAudioPlayback();

        // Re-apply media session state
        setupMediaSession();
      }
    };

    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange
    );

    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
    };
  }, [role]);

  // --------------------------------------------------
  // 🧹 CLEANUP WAKE LOCK
  // --------------------------------------------------

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }

      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.playbackState = "none";
          navigator.mediaSession.metadata = null;
        } catch {
          // Ignore cleanup errors
        }
      }
    };
  }, []);

  // --------------------------------------------------
  // 📱 QR ROOM DETECTION
  // --------------------------------------------------

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search
    );

    const roomFromQR = params.get("room");

    if (roomFromQR) {
      const code = roomFromQR.trim().toUpperCase();

      console.log("📱 QR room detected:", code);

      setQrRoom(code);
      setJoinCode(code);
    }
  }, []);

  // --------------------------------------------------
  // 📊 WEBRTC DIAGNOSTICS
  // --------------------------------------------------

  const collectStats = async () => {
    const pc = peerConnection.current;

    if (!pc) return;

    try {
      const reports = await pc.getStats();

      let rtt = "-";
      let jitter = "-";
      let packetsLost = "-";
      let jitterBuffer = "-";

      reports.forEach((report) => {
        // ------------------------------------------
        // NETWORK RTT
        // ------------------------------------------

        if (
          report.type === "candidate-pair" &&
          report.state === "succeeded"
        ) {
          if (report.currentRoundTripTime != null) {
            rtt = Math.round(
              report.currentRoundTripTime * 1000
            );
          }
        }

        // ------------------------------------------
        // INCOMING AUDIO
        // ------------------------------------------

        if (report.type === "inbound-rtp") {
          const isAudio =
            report.kind === "audio" ||
            report.mediaType === "audio";

          if (!isAudio) return;

          // ----------------------------------------
          // JITTER
          // ----------------------------------------

          if (report.jitter != null) {
            jitter = Math.round(
              report.jitter * 1000
            );
          }

          // ----------------------------------------
          // PACKETS LOST
          // ----------------------------------------

          if (report.packetsLost != null) {
            packetsLost = report.packetsLost;
          }

          // ----------------------------------------
          // JITTER BUFFER
          //
          // IMPORTANT:
          // jitterBufferDelay is cumulative.
          //
          // We calculate the delay added during
          // this measurement interval instead of
          // blindly displaying the cumulative value.
          // ----------------------------------------

          if (
            report.jitterBufferDelay != null &&
            report.jitterBufferEmittedCount != null &&
            report.jitterBufferEmittedCount > 0
          ) {
            const previous =
              previousStatsRef.current;

            const delayDelta =
              report.jitterBufferDelay -
              previous.jitterBufferDelay;

            const emittedDelta =
              report.jitterBufferEmittedCount -
              previous.jitterBufferEmittedCount;

            if (emittedDelta > 0) {
              const intervalDelay =
                delayDelta / emittedDelta;

              jitterBuffer = Math.round(
                intervalDelay * 1000
              );
            } else {
              // First sample / no new emitted packets
              const averageDelay =
                report.jitterBufferDelay /
                report.jitterBufferEmittedCount;

              jitterBuffer = Math.round(
                averageDelay * 1000
              );
            }

            previousStatsRef.current = {
              ...previousStatsRef.current,
              jitterBufferDelay:
                report.jitterBufferDelay,
              jitterBufferEmittedCount:
                report.jitterBufferEmittedCount,
            };
          }

          // Store packet-loss counter
          if (report.packetsLost != null) {
            previousStatsRef.current = {
              ...previousStatsRef.current,
              packetsLost: report.packetsLost,
            };
          }
        }
      });

      setStats({
        rtt,
        jitter,
        packetsLost,
        jitterBuffer,
      });

      console.log("📊 SyncSound Stats:", {
        rtt: `${rtt} ms`,
        jitter: `${jitter} ms`,
        packetsLost,
        jitterBuffer: `${jitterBuffer} ms`,
      });
    } catch (error) {
      console.error("❌ Stats error:", error);
    }
  };

  // --------------------------------------------------
  // 📊 COLLECT STATS EVERY SECOND
  // --------------------------------------------------

  useEffect(() => {
    const interval = setInterval(() => {
      collectStats();
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  // --------------------------------------------------
  // 🔄 WEBRTC AUTO-RECONNECT
  // --------------------------------------------------

  const scheduleReconnect = () => {
    if (reconnectTimerRef.current) {
      return;
    }

    const currentRoom = roomIdRef.current;
    const currentPc = peerConnection.current;

    if (!currentRoom || !currentPc || !role) {
      return;
    }

    if (
      currentPc.connectionState === "connected" ||
      currentPc.connectionState === "connecting"
    ) {
      return;
    }

    const attempt = reconnectAttemptsRef.current + 1;

    if (attempt > 5) {
      console.log("🛑 Maximum reconnect attempts reached");
      setStatus("❌ Reconnect failed. Please rejoin the room.");
      return;
    }

    reconnectAttemptsRef.current = attempt;

    const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);

    console.log(
      `🔄 Reconnect attempt ${attempt}/5 in ${delay}ms`
    );

    setStatus(
      `🔄 Reconnecting (${attempt}/5)...`
    );

    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null;

      try {
        const pc = peerConnection.current;

        if (!pc || pc.connectionState === "connected") {
          return;
        }

        // The laptop is the WebRTC offerer.
        // Ask it to create an ICE-restart offer.
        if (role === "phone") {
          console.log(
            "📱 Phone requesting laptop to restart ICE"
          );

          socket.emit("join-room", currentRoom);
          return;
        }

        if (role === "laptop") {
          console.log(
            "💻 Laptop creating ICE-restart offer"
          );

          const offer = await pc.createOffer({
            iceRestart: true,
          });

          await pc.setLocalDescription(offer);

          socket.emit("offer", {
            roomId: currentRoom,
            offer,
          });

          console.log(
            "📤 ICE-restart offer sent"
          );
        }
      } catch (error) {
        console.error(
          "❌ Reconnect attempt failed:",
          error
        );

        scheduleReconnect();
      }
    }, delay);
  };

  const resetReconnectState = () => {
    reconnectAttemptsRef.current = 0;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  // --------------------------------------------------
  // 🔧 CREATE WEBRTC PEER CONNECTION
  // --------------------------------------------------


  // --------------------------------------------------
  // ⚡ LOW-LATENCY AUDIO TRACK
  // --------------------------------------------------

  const addLowLatencyAudioTrack = (pc, stream) => {
    const audioTrack = stream.getAudioTracks()[0];

    if (!audioTrack) {
      console.log("⚠️ No audio track found");
      return;
    }

    // Request the lowest capture latency supported by the browser.
    try {
      audioTrack.applyConstraints({
        latency: { ideal: 0 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }).catch((error) => {
        console.log("⚠️ Low-latency constraints not applied:", error);
      });
    } catch (error) {
      console.log("⚠️ Track constraints unavailable:", error);
    }

    // Prefer Opus for WebRTC audio when the browser supports
    // codec preference control.
    try {
      if (
        typeof pc.addTransceiver === "function" &&
        typeof RTCRtpSender !== "undefined" &&
        RTCRtpSender.getCapabilities
      ) {
        const capabilities = RTCRtpSender.getCapabilities("audio");

        const opusCodecs =
          capabilities?.codecs?.filter(
            (codec) =>
              codec.mimeType?.toLowerCase() === "audio/opus"
          ) || [];

        if (opusCodecs.length > 0) {
          const transceiver = pc.addTransceiver(audioTrack, {
            direction: "sendonly",
            streams: [stream],
          });

          transceiver.setCodecPreferences(opusCodecs);

          console.log("⚡ Opus low-latency audio sender configured");
          return;
        }
      }
    } catch (error) {
      console.log(
        "⚠️ Opus preference unavailable, falling back to addTrack:",
        error
      );
    }

    pc.addTrack(audioTrack, stream);
  };

  const createPeerConnection = (room) => {
    console.log(
      "🔧 Creating PeerConnection for room:",
      room
    );

    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302",
        },
      ],
    });

    // ------------------------------------------------
    // ICE
    // ------------------------------------------------

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("🧊 Sending ICE candidate");

        socket.emit("ice-candidate", {
          roomId: room,
          candidate: event.candidate,
        });
      }
    };

    // ------------------------------------------------
    // AUDIO TRACK
    // ------------------------------------------------

    pc.ontrack = (event) => {
      console.log("🎵 AUDIO TRACK RECEIVED!");

      const receiver = event.receiver;

      // Low-latency hint
      if ("playoutDelayHint" in receiver) {
        try {
          receiver.playoutDelayHint = 0;

          console.log(
            "⚡ Playout delay hint: 0"
          );
        } catch (error) {
          console.log(
            "⚠️ Could not set playoutDelayHint:",
            error
          );
        }
      }

      // Jitter buffer target hint
      if ("jitterBufferTarget" in receiver) {
        try {
          receiver.jitterBufferTarget = 0;

          console.log(
            "⚡ Jitter buffer target: 0"
          );
        } catch (error) {
          console.log(
            "⚠️ Could not set jitterBufferTarget:",
            error
          );
        }
      }

      const remoteStream =
        event.streams[0] ||
        new MediaStream([event.track]);

      remoteStreamRef.current = remoteStream;

      if (audioRef.current) {
        const audio = audioRef.current;

        audio.srcObject = remoteStream;

        // Configure media playback
        audio.autoplay = true;
        audio.playsInline = true;

        // Try immediate playback
        audio
          .play()
          .then(() => {
            console.log(
              "🔊 Remote audio playing"
            );

            setupMediaSession();

            if ("mediaSession" in navigator) {
              navigator.mediaSession.playbackState =
                "playing";
            }
          })
          .catch((error) => {
            console.log(
              "🔊 Press ▶️ to start audio",
              error
            );
          });
      }
    };

    // ------------------------------------------------
    // CONNECTION STATE
    // ------------------------------------------------

    pc.onconnectionstatechange = () => {
      console.log(
        "🔗 Connection state:",
        pc.connectionState
      );

      if (pc.connectionState === "connected") {
        console.log("✅ WebRTC connected");
        resetReconnectState();
        setStatus("🎵 Audio connection established!");
      }

      if (pc.connectionState === "connecting") {
        setStatus("🔄 Connecting audio...");
      }

      if (pc.connectionState === "disconnected") {
        console.log(
          "⚠️ WebRTC disconnected - starting recovery"
        );

        setStatus(
          "⚠️ Connection interrupted — recovering..."
        );

        scheduleReconnect();
      }

      if (pc.connectionState === "failed") {
        console.log(
          "❌ WebRTC failed - starting ICE recovery"
        );

        setStatus(
          "❌ Connection failed — reconnecting..."
        );

        scheduleReconnect();
      }
    };

    // ------------------------------------------------
    // ICE CONNECTION STATE
    // ------------------------------------------------

    pc.oniceconnectionstatechange = () => {
      console.log(
        "🧊 ICE state:",
        pc.iceConnectionState
      );

      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        resetReconnectState();
      }

      if (
        pc.iceConnectionState === "disconnected"
      ) {
        console.log(
          "⚠️ ICE connection disconnected"
        );

        scheduleReconnect();
      }

      if (
        pc.iceConnectionState === "failed"
      ) {
        console.log(
          "❌ ICE connection failed"
        );

        scheduleReconnect();
      }
    };

    peerConnection.current = pc;

    return pc;
  };

  // --------------------------------------------------
  // 🎵 AUDIO EVENT HANDLERS
  // --------------------------------------------------

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) return;

    const handlePlaying = () => {
      console.log("▶️ Audio playing");

      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.playbackState =
            "playing";
        } catch {}
      }
    };

    const handlePause = () => {
      console.log("⏸️ Audio paused");

      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.playbackState =
            "paused";
        } catch {}
      }
    };

    const handleWaiting = () => {
      console.log(
        "⏳ Audio waiting for data..."
      );
    };

    const handleStalled = () => {
      console.log(
        "⚠️ Audio stalled - attempting recovery..."
      );

      setTimeout(() => {
        recoverAudioPlayback();

        const pc = peerConnection.current;

        if (
          pc &&
          (
            pc.connectionState === "disconnected" ||
            pc.connectionState === "failed" ||
            pc.iceConnectionState === "disconnected" ||
            pc.iceConnectionState === "failed"
          )
        ) {
          scheduleReconnect();
        }
      }, 500);
    };

    const handleError = () => {
      console.log(
        "❌ Audio element error"
      );
    };

    audio.addEventListener(
      "playing",
      handlePlaying
    );

    audio.addEventListener(
      "pause",
      handlePause
    );

    audio.addEventListener(
      "waiting",
      handleWaiting
    );

    audio.addEventListener(
      "stalled",
      handleStalled
    );

    audio.addEventListener(
      "error",
      handleError
    );

    return () => {
      audio.removeEventListener(
        "playing",
        handlePlaying
      );

      audio.removeEventListener(
        "pause",
        handlePause
      );

      audio.removeEventListener(
        "waiting",
        handleWaiting
      );

      audio.removeEventListener(
        "stalled",
        handleStalled
      );

      audio.removeEventListener(
        "error",
        handleError
      );
    };
  }, [role]);

  // --------------------------------------------------
  // 🔌 SOCKET.IO LISTENERS
  // --------------------------------------------------

  useEffect(() => {
    console.log(
      "🔌 Registering Socket.IO listeners"
    );

    // ----------------------------------------------
    // PHONE JOINED LAPTOP ROOM
    // ----------------------------------------------

    const handleUserJoined = async (socketId) => {
      console.log(
        "📱 Phone joined:",
        socketId
      );

      if (!localStream.current) {
        console.log(
          "❌ No laptop audio stream"
        );
        return;
      }

      if (!peerConnection.current) {
        console.log(
          "❌ No PeerConnection"
        );
        return;
      }

      setStatus(
        "Phone connected. Creating audio connection..."
      );

      try {
        console.log(
          "📨 Creating WebRTC offer..."
        );

        const currentPc =
          peerConnection.current;

        const shouldRestartIce =
          currentPc.connectionState === "disconnected" ||
          currentPc.connectionState === "failed" ||
          currentPc.iceConnectionState === "disconnected" ||
          currentPc.iceConnectionState === "failed";

        const offer =
          await currentPc.createOffer({
            iceRestart: shouldRestartIce,
          });

        await currentPc.setLocalDescription(
          offer
        );

        if (shouldRestartIce) {
          console.log(
            "♻️ ICE restart enabled for recovery"
          );
        }

        console.log(
          "📨 Sending offer to room:",
          roomIdRef.current
        );

        socket.emit("offer", {
          roomId: roomIdRef.current,
          offer,
        });
      } catch (error) {
        console.error(
          "❌ Offer creation error:",
          error
        );
      }
    };

    // ----------------------------------------------
    // PHONE RECEIVES OFFER
    // ----------------------------------------------

    const handleOffer = async ({
      offer,
      roomId: incomingRoom,
    }) => {
      console.log(
        "📨 OFFER RECEIVED"
      );

      if (role !== "phone") {
        console.log(
          "Not phone, ignoring offer"
        );
        return;
      }

      setStatus(
        "Laptop found. Connecting..."
      );

      try {
        if (!peerConnection.current) {
          createPeerConnection(
            incomingRoom
          );
        }

        const pc =
          peerConnection.current;

        console.log(
          "📥 Setting remote description"
        );

        await pc.setRemoteDescription(
          new RTCSessionDescription(
            offer
          )
        );

        // Add queued ICE candidates
        for (
          const candidate of
          pendingCandidates.current
        ) {
          try {
            await pc.addIceCandidate(
              candidate
            );
          } catch (error) {
            console.error(
              "Queued ICE error:",
              error
            );
          }
        }

        pendingCandidates.current = [];

        console.log(
          "📨 Creating answer"
        );

        const answer =
          await pc.createAnswer();

        await pc.setLocalDescription(
          answer
        );

        console.log(
          "📨 Sending answer"
        );

        socket.emit("answer", {
          roomId: incomingRoom,
          answer,
        });
      } catch (error) {
        console.error(
          "❌ Offer handling error:",
          error
        );
      }
    };

    // ----------------------------------------------
    // LAPTOP RECEIVES ANSWER
    // ----------------------------------------------

    const handleAnswer = async ({
      answer,
    }) => {
      console.log(
        "📨 ANSWER RECEIVED"
      );

      if (!peerConnection.current) {
        console.log(
          "❌ No PeerConnection"
        );
        return;
      }

      try {
        await peerConnection.current.setRemoteDescription(
          new RTCSessionDescription(
            answer
          )
        );

        console.log(
          "✅ Remote description set"
        );

        // Add queued ICE candidates
        for (
          const candidate of
          pendingCandidates.current
        ) {
          try {
            await peerConnection.current.addIceCandidate(
              candidate
            );
          } catch (error) {
            console.error(
              "Queued ICE error:",
              error
            );
          }
        }

        pendingCandidates.current = [];

        resetReconnectState();

        setStatus(
          "🎵 Audio connection established!"
        );
      } catch (error) {
        console.error(
          "❌ Answer handling error:",
          error
        );
      }
    };

    // ----------------------------------------------
    // ICE CANDIDATE
    // ----------------------------------------------

    const handleIceCandidate = async ({
      candidate,
    }) => {
      console.log(
        "🧊 ICE candidate received"
      );

      if (!candidate) return;

      if (
        peerConnection.current &&
        peerConnection.current.remoteDescription
      ) {
        try {
          await peerConnection.current.addIceCandidate(
            new RTCIceCandidate(
              candidate
            )
          );

          console.log(
            "✅ ICE candidate added"
          );
        } catch (error) {
          console.error(
            "❌ ICE candidate error:",
            error
          );
        }
      } else {
        console.log(
          "⏳ Queueing ICE candidate"
        );

        pendingCandidates.current.push(
          new RTCIceCandidate(candidate)
        );
      }
    };

    socket.on(
      "user-joined",
      handleUserJoined
    );

    socket.on(
      "offer",
      handleOffer
    );

    socket.on(
      "answer",
      handleAnswer
    );

    socket.on(
      "ice-candidate",
      handleIceCandidate
    );

    return () => {
      socket.off(
        "user-joined",
        handleUserJoined
      );

      socket.off(
        "offer",
        handleOffer
      );

      socket.off(
        "answer",
        handleAnswer
      );

      socket.off(
        "ice-candidate",
        handleIceCandidate
      );
    };
  }, [role]);

  // --------------------------------------------------
  // CREATE ROOM - LAPTOP
  // --------------------------------------------------

  const createRoom = async () => {
    try {
      console.log(
        "💻 Starting laptop mode"
      );

      // Check browser support
      if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getDisplayMedia
      ) {
        console.error(
          "❌ getDisplayMedia is not available"
        );

        setStatus(
          "❌ Screen/audio capture is not available. Use Chrome with a secure origin."
        );

        return;
      }

      const stream =
        await navigator.mediaDevices.getDisplayMedia(
          {
            video: true,
            audio: {
              latency: { ideal: 0 },
              channelCount: { ideal: 2 },
              sampleRate: { ideal: 48000 },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          }
        );

      console.log(
        "🎤/🔊 Display audio access granted"
      );

      try {
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          console.log(
            "🎛️ Actual audio capture settings:",
            audioTrack.getSettings()
          );
        }
      } catch (error) {
        console.log("⚠️ Could not read capture settings:", error);
      }

      localStream.current = stream;

      const newRoom =
        Math.random()
          .toString(36)
          .substring(2, 8)
          .toUpperCase();

      roomIdRef.current =
        newRoom;

      setRoomId(newRoom);

      resetReconnectState();

      setRole("laptop");

      setStatus(
        "Room created. Waiting for phone..."
      );

      console.log(
        "🏠 Creating room:",
        newRoom
      );

      socket.emit(
        "create-room",
        newRoom
      );

      const pc =
        createPeerConnection(
          newRoom
        );

      addLowLatencyAudioTrack(pc, stream);

      console.log(
        "🎵 Laptop low-latency audio track added"
      );

      // If screen sharing stops
      stream
        .getVideoTracks()
        .forEach((track) => {
          track.onended = () => {
            console.log(
              "🛑 Screen sharing stopped"
            );

            setStatus(
              "⚠️ Screen sharing stopped"
            );
          };
        });
    } catch (error) {
      console.error(
        "❌ Audio capture error:",
        error
      );

      if (
        error.name ===
        "NotAllowedError"
      ) {
        setStatus(
          "❌ Screen/audio sharing was cancelled"
        );
      } else {
        setStatus(
          "❌ Audio capture permission failed"
        );
      }
    }
  };

  // --------------------------------------------------
  // JOIN ROOM - PHONE
  // --------------------------------------------------

  const joinRoom = (
    roomOverride = ""
  ) => {
    const code =
      roomOverride ||
      joinCode.trim();

    if (!code) {
      alert(
        "Enter the room code"
      );
      return;
    }

    const normalizedCode =
      code.toUpperCase();

    console.log(
      "📱 Joining room:",
      normalizedCode
    );

    roomIdRef.current =
      normalizedCode;

    setRoomId(
      normalizedCode
    );

    setJoinCode(
      normalizedCode
    );

    resetReconnectState();

    setRole("phone");

    setStatus(
      "Joining room..."
    );

    // 🔒 Request Wake Lock
    requestWakeLock();

    // 🎵 Setup media session
    setupMediaSession();

    // Create PeerConnection BEFORE joining
    if (
      !peerConnection.current
    ) {
      createPeerConnection(
        normalizedCode
      );
    }

    socket.emit(
      "join-room",
      normalizedCode
    );
  };

  // --------------------------------------------------
  // AUTO JOIN FROM QR
  // --------------------------------------------------

  useEffect(() => {
    if (!qrRoom) return;

    console.log(
      "📱 Automatically joining QR room:",
      qrRoom
    );

    const timer =
      setTimeout(() => {
        joinRoom(qrRoom);
      }, 500);

    return () => {
      clearTimeout(timer);
    };
  }, [qrRoom]);

  // --------------------------------------------------
  // QR URL
  // --------------------------------------------------

  const qrUrl = roomId
    ? `${window.location.origin}/?room=${roomId}`
    : "";

  // --------------------------------------------------
  // UI
  // --------------------------------------------------

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "40px",
        fontFamily: "Arial",
        background: "#111",
        color: "white",
      }}
    >
      <h1>🎵 SyncSound</h1>

      <p>
        Turn your phone into a wireless speaker.
      </p>

      <hr />

      {/* ------------------------------------------
          HOME
      ------------------------------------------ */}

      {!role && (
        <>
          <h2>💻 Laptop</h2>

          <button
            onClick={createRoom}
            style={{
              padding: "12px 20px",
              fontSize: "16px",
              cursor: "pointer",
            }}
          >
            Create Room
          </button>

          <h2
            style={{
              marginTop: "40px",
            }}
          >
            📱 Phone
          </h2>

          <input
            type="text"
            placeholder="Enter room code"
            value={joinCode}
            onChange={(e) =>
              setJoinCode(
                e.target.value
              )
            }
            style={{
              padding: "12px",
              fontSize: "16px",
            }}
          />

          <button
            onClick={() =>
              joinRoom()
            }
            style={{
              marginLeft: "10px",
              padding: "12px 20px",
              fontSize: "16px",
              cursor: "pointer",
            }}
          >
            Join Room
          </button>
        </>
      )}

      {/* ------------------------------------------
          LAPTOP
      ------------------------------------------ */}

      {role === "laptop" && (
        <>
          <h2>
            💻 Laptop Mode
          </h2>

          <h1
            style={{
              letterSpacing: "8px",
            }}
          >
            {roomId}
          </h1>

          <p>{status}</p>

          <p>
            📱 Scan this QR code with your phone.
          </p>

          {qrUrl && (
            <div
              style={{
                marginTop: "20px",
                padding: "20px",
                background: "white",
                borderRadius: "16px",
                width: "fit-content",
                textAlign: "center",
              }}
            >
              <QRCodeSVG
                value={qrUrl}
                size={220}
                level="H"
              />

              <p
                style={{
                  color: "#111",
                  fontWeight: "bold",
                  marginBottom: "5px",
                }}
              >
                📱 Scan to connect
              </p>

              <p
                style={{
                  color: "#555",
                  margin: 0,
                  fontSize: "14px",
                }}
              >
                Room: {roomId}
              </p>
            </div>
          )}

          <p
            style={{
              marginTop: "20px",
              opacity: 0.7,
            }}
          >
            Or enter the room code manually:
            <br />
            <strong>
              {roomId}
            </strong>
          </p>
        </>
      )}

      {/* ------------------------------------------
          PHONE
      ------------------------------------------ */}

      {role === "phone" && (
        <>
          <h2>
            📱 Phone Speaker Mode
          </h2>

          <p>{status}</p>

          {/* --------------------------------------
              WAKE LOCK STATUS
          -------------------------------------- */}

          <div
            style={{
              marginTop: "15px",
              padding: "12px 15px",
              background:
                wakeLockActive
                  ? "#123d24"
                  : "#222",
              borderRadius: "10px",
              border:
                wakeLockActive
                  ? "1px solid #1f8f4d"
                  : "1px solid #333",
            }}
          >
            {wakeLockActive ? (
              <span>
                🔒 Screen staying awake
              </span>
            ) : (
              <span>
                ⚠️ Screen wake lock inactive
              </span>
            )}
          </div>

          {/* --------------------------------------
              DIAGNOSTICS
          -------------------------------------- */}

          <div
            style={{
              marginTop: "20px",
              padding: "15px",
              background: "#222",
              borderRadius: "12px",
              fontFamily: "monospace",
              border: "1px solid #333",
            }}
          >
            <h3>
              📊 WebRTC Diagnostics
            </h3>

            <p>
              🌐 RTT:{" "}
              <strong>
                {stats.rtt}
              </strong>{" "}
              ms
            </p>

            <p>
              📡 Jitter:{" "}
              <strong>
                {stats.jitter}
              </strong>{" "}
              ms
            </p>

            <p>
              📦 Packets Lost:{" "}
              <strong>
                {stats.packetsLost}
              </strong>
            </p>

            <p>
              ⏱️ Jitter Buffer:{" "}
              <strong>
                {stats.jitterBuffer}
              </strong>{" "}
              ms
            </p>
          </div>

          {/* --------------------------------------
              AUDIO PLAYER
          -------------------------------------- */}

          <audio
            ref={audioRef}
            controls
            autoPlay
            playsInline
            preload="auto"
            style={{
              width: "100%",
              marginTop: "20px",
            }}
          />

          <p
            style={{
              marginTop: "20px",
              opacity: 0.7,
            }}
          >
            If you don't hear audio
            automatically, press ▶️
            on the player.
          </p>

          <button
            onClick={async () => {
              await requestWakeLock();
              await recoverAudioPlayback();
            }}
            style={{
              marginTop: "10px",
              padding: "10px 16px",
              cursor: "pointer",
              borderRadius: "8px",
              border: "none",
            }}
          >
            🔒 Keep Screen Awake
          </button>
        </>
      )}
    </div>
  );
}

export default App;