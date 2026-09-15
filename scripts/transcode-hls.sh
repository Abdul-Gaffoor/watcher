#!/usr/bin/env bash
# Turns a source video into the multi-bitrate HLS ladder the player expects.
#
#   ./scripts/transcode-hls.sh input.mp4 harmonic-foundations
#
# Output: content/media/titles/<id>/hls/master.m3u8 plus per-rendition segments.
# Requires ffmpeg.
set -euo pipefail

INPUT="${1:-}"
TITLE_ID="${2:-}"

if [[ -z "$INPUT" || -z "$TITLE_ID" ]]; then
  echo "Usage: $0 <input-video> <title-id>" >&2
  exit 1
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[[ -f "$INPUT" ]] || { echo "No such file: $INPUT" >&2; exit 1; }

OUT_DIR="content/media/titles/$TITLE_ID/hls"
mkdir -p "$OUT_DIR"

# 6-second segments: a good balance between startup latency and request count.
ffmpeg -hide_banner -y -i "$INPUT" \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
    [v1]scale=w=640:h=360:force_original_aspect_ratio=decrease[v1out]; \
    [v2]scale=w=1280:h=720:force_original_aspect_ratio=decrease[v2out]; \
    [v3]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[v3out]" \
  -map '[v1out]' -c:v:0 libx264 -b:v:0 800k  -maxrate:v:0 856k  -bufsize:v:0 1200k \
  -map '[v2out]' -c:v:1 libx264 -b:v:1 2800k -maxrate:v:1 2996k -bufsize:v:1 4200k \
  -map '[v3out]' -c:v:2 libx264 -b:v:2 5000k -maxrate:v:2 5350k -bufsize:v:2 7500k \
  -map a:0 -map a:0 -map a:0 -c:a aac -b:a 128k -ac 2 \
  -preset veryfast -g 48 -keyint_min 48 -sc_threshold 0 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_type mpegts \
  -hls_segment_filename "$OUT_DIR/stream_%v/segment_%03d.ts" \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  "$OUT_DIR/stream_%v/playlist.m3u8"

DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT" | cut -d. -f1)"
echo
echo "Wrote $OUT_DIR/master.m3u8"
echo "Set \"durationSec\": $DURATION on title \"$TITLE_ID\" in content/catalog.json"
