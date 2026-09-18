# Loona Native Agora Probe

This add-on is a diagnostic step toward replacing the browser bridge. It joins
the active Loona Agora session and reports encoded video callbacks. It does not
decode video or send camera frames to Home Assistant.

Run it with the Firefox bridge stopped, then switch the Loona camera on once.
Successful output includes `Agora connected` and `encoded frames=`.
