declare interface Settings {
    episodeServers: string[]
    supportsDub: boolean
}

declare interface SearchOptions {
    query: string
    dub?: boolean
}

declare interface SearchResult {
    id: string
    title: string
    url: string
    subOrDub: "sub" | "dub" | "both"
    poster?: string
}

declare interface EpisodeDetails {
    id: string
    number: number
    url: string
    title: string
}

declare interface VideoSource {
    url: string
    quality: string
    type: string
    subtitles: { url: string; lang: string }[]
}

declare interface EpisodeServer {
    server: string
    headers: Record<string, string>
    videoSources: VideoSource[]
}


