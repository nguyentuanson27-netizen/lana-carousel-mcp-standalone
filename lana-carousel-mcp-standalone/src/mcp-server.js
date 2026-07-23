import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { publicError } from "./errors.js";
import { addSlide, createProject, getProject, importAssetFromUrl } from "./service.js";

const server = new McpServer({ name: "lana-carousel-standalone", version: "1.0.0" });

function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function fail(error) {
  const safe = publicError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(safe) }] };
}

server.tool("create_project", "Create a standalone carousel project.", {
  title: z.string().min(1).max(200),
  topic: z.string().max(500).optional()
}, async (args) => {
  try { return ok(createProject(args)); } catch (error) { return fail(error); }
});

server.tool("add_slide", "Add a slide to a carousel project.", {
  project_id: z.string().uuid(),
  position: z.number().int().positive(),
  subject: z.string().min(1),
  headline: z.string().min(1),
  body: z.string().min(1)
}, async (args) => {
  try {
    return ok(addSlide({ projectId: args.project_id, position: args.position, subject: args.subject, headline: args.headline, body: args.body }));
  } catch (error) { return fail(error); }
});

server.tool("get_project", "Get a project with slides and image assets.", {
  project_id: z.string().uuid()
}, async (args) => {
  try { return ok(getProject(args.project_id)); } catch (error) { return fail(error); }
});

server.tool(
  "import_asset_from_url",
  "Download the exact public image belonging to the slide subject, create or reuse an asset, and assign it to the slide. Do not use a visually similar substitute.",
  {
    project_id: z.string().uuid(),
    slide_id: z.string().uuid(),
    image_url: z.string().url(),
    source_page_url: z.string().url().optional(),
    source_title: z.string().max(500).optional(),
    source_publisher: z.string().max(200).optional(),
    source_type: z.enum(["official_brand", "official_social", "news", "magazine", "unknown"]).optional(),
    alt_text: z.string().max(500).optional(),
    force_replace: z.boolean().optional()
  },
  async (args) => {
    try {
      return ok(await importAssetFromUrl({
        projectId: args.project_id,
        slideId: args.slide_id,
        imageUrl: args.image_url,
        sourcePageUrl: args.source_page_url,
        sourceTitle: args.source_title,
        sourcePublisher: args.source_publisher,
        sourceType: args.source_type,
        altText: args.alt_text,
        forceReplace: args.force_replace || false
      }));
    } catch (error) { return fail(error); }
  }
);

await server.connect(new StdioServerTransport());
