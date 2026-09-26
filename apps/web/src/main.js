/* Entry point. Order matters: ui.js defines the UI object that admin.js and panels.js extend; panels.js boots. */
import './ui/scene.js';
import './ui/ui.js';
import './ui/admin.js';
import './ui/data-admin.js';
import './ui/panels.js';
