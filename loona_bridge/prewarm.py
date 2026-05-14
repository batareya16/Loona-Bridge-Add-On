#!/usr/bin/env python3
"""
Docker build pre-warm: directly download OpenH264 GMP from Mozilla CDN.

1. Find the Playwright Firefox installation and read its version.
2. Query Mozilla's GMP update server for the OpenH264 download URL.
3. Download the ZIP and extract into /opt/ff-profile/gmp-gmpopenh264/{version}/.

Firefox finds the GMP in the persistent profile directory at startup — no network
request needed at runtime. If this script fails (no CDN access during build),
bridge.html's waitForH264Codec() loop handles the runtime fallback.
"""
import sys, os, re, glob, platform, urllib.request, urllib.error, zipfile, io

PLAYWRIGHT_PATH = os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
PROFILE_DIR     = os.environ.get('FIREFOX_PROFILE_DIR',      '/opt/ff-profile')

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

    # Extract into profile
    gmp_dir = os.path.join(PROFILE_DIR, 'gmp-gmpopenh264', h264_version)
    os.makedirs(gmp_dir, exist_ok=True)
    try:
        with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
            z.extractall(gmp_dir)
    except zipfile.BadZipFile:
        # Some older builds use bzip2 .so.bz2 format
        import bz2
        so_data = bz2.decompress(zip_data)
        with open(os.path.join(gmp_dir, 'libgmpopenh264.so'), 'wb') as f:
            f.write(so_data)

    files = os.listdir(gmp_dir)
    log(f'Extracted to {gmp_dir}: {", ".join(files)}')
    log('SUCCESS — OpenH264 baked into Docker image')

try:
    main()
except Exception as e:
    print('[prewarm] Unexpected error: ' + str(e))
    # Never fail the Docker build
sys.exit(0)
