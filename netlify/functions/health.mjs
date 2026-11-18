import { adapt } from "../../lib/netlify.js";
import handler from "../../api/health.js";

export default adapt(handler);
