#!/usr/bin/env python3
"""
Docker build pre-warm: download OpenH264 GMP and place it inside the Firefox
BINARY directory so it is baked into the Docker image layer.

  {PLAYWRIGHT_BROWSERS_PATH}/firefox-*/firefox/gmp-gmpopenh264/{version}/
    libgmpopenh264.so
    gmpopenh264.info

Firefox searches for GMP plugins in the directory containing the firefox binary
in addition to the profile. By placing the plugin there (not in the profile),
it survives container recreates — the profile (/opt/ff-profile) is a writable
layer that resets, but the Firefox binary dir is part of the read-only image.

If this script fails (no CDN access during build), bridge.html's
waitForH264Codec() polls RTCPeerConnection.createOffer() and waits up to 120 s
for Firefox to download the GMP at runtime (runtime fallback).
"""
import sys, os, re, glob, platform, urllib.request, urllib.error, zipfile, io

PLAYWRIGHT_PATH = os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')

def log(msg):
    print('[prewarm] ' + msg, flush=True)

def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (prewarm)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def main():
    # Find Playwright Firefox installation dir
    ff_dirs = glob.glob(os.path.join(PLAYWRIGHT_PATH, 'firefox-*/firefox'))
    if not ff_dirs:
        log('ERROR: Firefox not found in ' + PLAYWRIGHT_PATH)
        return
    ff_dir = sorted(ff_dirs)[-1]
    log('Firefox dir: ' + ff_dir)

    # Read version + build ID from application.ini
    ini_path = os.path.join(ff_dir, 'application.ini')
    try:
        ini = open(ini_path).read()
    except OSError as e:
        log('Cannot read application.ini: ' + str(e))
        return
    m_ver = re.search(r'^Version=(.+)$', ini, re.M)
    m_bid = re.search(r'^BuildID=(.+)$', ini, re.M)
    if not m_ver or not m_bid:
        log('Cannot parse version from application.ini')
        return
    ff_version = m_ver.group(1).strip()
    build_id   = m_bid.group(1).strip()
    log(f'Firefox {ff_version} (BuildID={build_id})')

    # GMP platform string
    arch = platform.machine()  # 'aarch64' or 'x86_64'
    gmp_platform = 'Linux_aarch64-gcc3' if arch == 'aarch64' else 'Linux_x86_64-gcc3'
    log('GMP platform: ' + gmp_platform)

    # Query Mozilla GMP update server
    gmp_url = (
        f'https://aus5.mozilla.org/update/3/GMP/{ff_version}/{build_id}'
        f'/{gmp_platform}/en-US/release/default/default/update.xml'
    )
    log('Querying: ' + gmp_url)
    try:
        xml_data = fetch(gmp_url, timeout=30)
    except Exception as e:
        log('GMP server unreachable: ' + str(e))
        log('OpenH264 will be downloaded at first runtime instead.')
        return
    log(f'GMP XML received ({len(xml_data)} bytes)')

    # Parse OpenH264 URL and version from XML (no external XML library needed)
    xml = xml_data.decode('utf-8', errors='replace')
    # Find the gmp-gmpopenh264 block
    m_block = re.search(r'id="gmp-gmpopenh264"(.*?)(?=<addon|</addons>)', xml, re.S)
    if not m_block:
        log('OpenH264 not found in XML. First 800 chars:')
        log(xml[:800])
        return
    block = m_block.group(0)
    m_url = re.search(r'URL="([^"]+)"', block)
    m_ver2 = re.search(r'version="([^"]+)"', block)
    if not m_url:
        log('Cannot find download URL in OpenH264 block: ' + block[:300])
        return
    h264_url     = m_url.group(1)
    h264_version = m_ver2.group(1) if m_ver2 else 'unknown'
    log(f'Downloading OpenH264 {h264_version}: {h264_url}')

    # Download ZIP
    try:
        zip_data = fetch(h264_url, timeout=120)
    except Exception as e:
        log('Download failed: ' + str(e))
        return
    log(f'Downloaded {len(zip_data):,} bytes')

    # Extract into Firefox BINARY dir — survives container recreates (image layer).
    # Profile dir (/opt/ff-profile) resets on rebuild; binary dir does not.
    gmp_dir = os.path.join(ff_dir, 'gmp-gmpopenh264', h264_version)
    os.makedirs(gmp_dir, exist_ok=True)
    try:
        with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
            z.extractall(gmp_dir)
        log(f'Extracted ZIP to {gmp_dir}: {", ".join(os.listdir(gmp_dir))}')
    except zipfile.BadZipFile:
        # Older/ARM builds may ship bzip2-compressed .so instead of ZIP
        import bz2
        so_data = bz2.decompress(zip_data)
        so_path = os.path.join(gmp_dir, 'libgmpopenh264.so')
        with open(so_path, 'wb') as f:
            f.write(so_data)
        # Firefox requires gmpopenh264.info alongside the .so
        info_path = os.path.join(gmp_dir, 'gmpopenh264.info')
        with open(info_path, 'w') as f:
            f.write(f'Name=gmpopenh264\n'
                    f'Description=OpenH264 Video Codec provided by Cisco Systems, Inc.\n'
                    f'Version={h264_version}\n'
                    f'Vendor=Cisco Systems, Inc.\n'
                    f'ABI=gmpopenh264-ABI-1\n')
        log(f'Extracted bz2 to {gmp_dir}: {", ".join(os.listdir(gmp_dir))}')

    # Verify required files present
    files = os.listdir(gmp_dir)
    has_so   = any(f.endswith('.so') or f.endswith('.dll') or f.endswith('.dylib') for f in files)
    has_info = any(f.endswith('.info') for f in files)
    if not has_so:
        log('WARNING: no .so found in ' + gmp_dir + ' — Firefox may not load GMP')
    if not has_info:
        log('WARNING: no .info found — creating minimal one')
        with open(os.path.join(gmp_dir, 'gmpopenh264.info'), 'w') as f:
            f.write(f'Name=gmpopenh264\n'
                    f'Description=OpenH264 Video Codec provided by Cisco Systems, Inc.\n'
                    f'Version={h264_version}\n'
                    f'Vendor=Cisco Systems, Inc.\n'
                    f'ABI=gmpopenh264-ABI-1\n')

    log(f'SUCCESS — OpenH264 {h264_version} baked into Firefox binary dir: {gmp_dir}')

try:
    main()
except Exception as e:
    print('[prewarm] Unexpected error: ' + str(e))
    # Never fail the Docker build
sys.exit(0)
