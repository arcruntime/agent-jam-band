/**
 * Feature flags shared by the server and the browser.
 *
 * VOX_ENABLED: false switches the vox agent off everywhere without removing any of its code. The server never calls the vox agent (and the melody is not asked to leave gaps for it), the browser writes no vox stage and plays no vox audio, and the vox is hidden from the graph (no vox agent node or motifs), the token counters, the Studio switches and the legend. Set it to true to bring everything back.
 */
export const VOX_ENABLED = false;
