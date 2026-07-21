import { Socket } from "net"
import { ModSocket } from "./utils"
import { loadConfig } from "./configLoader"

interface Config {
    LATEST_VERSION: number
    FIRST_VERSION: number
    MAX_REQUESTS_IN_30: number
}

interface ServerData {
    connectedSockets: ModSocket[]
    discordSocket: Socket | undefined
    config: Config;
    stats: ServerStats;
}

interface ServerStats {
    totalConnections: number;
    online: number;
}

export const serverData: ServerData = {
    stats: {
        totalConnections: 0,
        online: 0
    },
    connectedSockets: [],
    discordSocket: undefined,
    config: loadConfig()
}