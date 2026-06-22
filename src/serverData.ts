import { Socket } from "net"
import { ModSocket } from "./utils"
import { loadConfig } from "./main"

interface Config {
    LATEST_VERSION: number
    FIRST_VERSION: number
    MAX_REQUESTS_IN_30: number
}

interface ServerData {
    connectedSockets: ModSocket[]
    discordSocket: Socket | undefined
    config: Config 
}

export const serverData: ServerData = {
    connectedSockets: [],
    discordSocket: undefined,
    config: loadConfig()
}