#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-parede}"

case "$MODE" in
  parede | emulador | simulador) ;;
  *)
    echo "Uso: npm run apresentacao -- [parede|emulador|simulador]"
    exit 1
    ;;
esac

lan_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  if [ -z "$ip" ]; then
    ip=$(ip -4 -o addr show scope global | awk '$2 !~ /^(docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4; exit }')
  fi
  echo "$ip"
}

find_wall() {
  if [ -n "${WALL_IP:-}" ]; then
    echo "$WALL_IP"
    return
  fi

  local ip
  ip=$(timeout 4 avahi-resolve -4 -n smash.local 2>/dev/null | awk '{print $2}' || true)
  if [ -n "$ip" ]; then
    echo "$ip"
    return
  fi

  node -e '
    const net = require("node:net");
    const self = process.argv[1];
    const prefix = self.split(".").slice(0, 3).join(".");
    let pending = 254;
    let found = false;
    for (let host = 1; host <= 254; host++) {
      const ip = `${prefix}.${host}`;
      const socket = net.connect({ host: ip, port: 81, timeout: 1500 });
      const done = (open) => {
        socket.destroy();
        if (open && !found && ip !== self) { found = true; console.log(ip); process.exit(0); }
        if (--pending === 0) process.exit(found ? 0 : 1);
      };
      socket.on("connect", () => done(true));
      socket.on("timeout", () => done(false));
      socket.on("error", () => done(false));
    }
  ' "$LAN" || true
}

env_value() {
  grep -E "^$1=" frontend/.env 2>/dev/null | tail -1 | cut -d= -f2- || true
}

LAN=$(lan_ip)
if [ -z "$LAN" ]; then
  echo "Sem rede. Conecte o notebook ao hotspot do celular e rode de novo."
  exit 1
fi

if ! pg_isready -h 127.0.0.1 -p 5433 -q; then
  echo "O PostgreSQL não está respondendo na porta 5433. Rode: sudo systemctl start postgresql"
  exit 1
fi

for port in 3000 5173 8081 8181; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    echo "A porta $port já está em uso. Feche o que estiver rodando nela (ou outro terminal com o npm start) e rode de novo."
    exit 1
  fi
done

COMMANDS=("npm:backend" "npm:web")
NAMES="backend,web"
COLORS="cyan,green"

case "$MODE" in
  parede)
    echo "Procurando a parede na rede $LAN ..."
    WALL=$(find_wall)
    if [ -z "$WALL" ]; then
      echo "Parede não encontrada. Ela está ligada e no mesmo hotspot? Veja o IP no Monitor Serial e rode:"
      echo "  WALL_IP=<ip-da-parede> npm run apresentacao"
      echo "Plano B, sem a parede: npm run apresentacao -- emulador"
      exit 1
    fi
    export EXPO_PUBLIC_DEVICE_SOURCE=websocket
    export EXPO_PUBLIC_DEVICE_URL="ws://$WALL:81"
    export EXPO_PUBLIC_DEVICE_TOKEN="$(env_value EXPO_PUBLIC_DEVICE_TOKEN)"
    ;;
  emulador)
    export EXPO_PUBLIC_DEVICE_SOURCE=websocket
    export EXPO_PUBLIC_DEVICE_URL="ws://$LAN:8181"
    export EXPO_PUBLIC_DEVICE_TOKEN=emulador-local
    export WALL_TOKEN=emulador-local
    COMMANDS+=("npm:wall")
    NAMES="$NAMES,parede"
    COLORS="$COLORS,yellow"
    ;;
  simulador)
    export EXPO_PUBLIC_DEVICE_SOURCE=simulated
    export EXPO_PUBLIC_DEVICE_URL=
    export EXPO_PUBLIC_DEVICE_TOKEN=
    ;;
esac

export EXPO_PUBLIC_API_URL="http://$LAN:3000"
export EXPO_PUBLIC_WEB_URL="http://$LAN:5173"
export REACT_NATIVE_PACKAGER_HOSTNAME="$LAN"

rm -rf /tmp/metro-* /tmp/haste-map-* 2>/dev/null || true

COMMANDS+=("npm --prefix frontend start -- --clear")
NAMES="$NAMES,app"
COLORS="$COLORS,magenta"

cat <<EOF

  ================================================================
   Smash — apresentação (modo: $MODE)
  ----------------------------------------------------------------
   Notebook ........ $LAN
   Parede .......... ${EXPO_PUBLIC_DEVICE_URL:-simulador do app}
   API ............. $EXPO_PUBLIC_API_URL
   Site ............ http://localhost:5173
   Câmera .......... http://localhost:5173/camera

   No celular (mesmo hotspot), Expo Go → "Enter URL manually":
     exp://$LAN:8081
  ================================================================

EOF

exec npx concurrently -n "$NAMES" -c "$COLORS" "${COMMANDS[@]}"
