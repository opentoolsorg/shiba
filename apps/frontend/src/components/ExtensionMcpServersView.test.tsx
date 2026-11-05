// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionMcpServersView } from "./ExtensionMcpServersView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Extension MCP uses the canonical reviewed registry", () => {
  it("uses normal HTTP and shows all six presets without shadow fixtures or unsupported controls", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path=String(input); calls.push(path);
      if(path === "/api/v1/mcp/servers") return Response.json({ servers: [] });
      if(path === "/api/agents") return Response.json({ principals: [] });
      if(path === "/api/v1/mcp/catalog-connections") return Response.json({ connections: [] });
      return Response.json({error:"Unexpected endpoint"},{status:404});
    }));
    render(<ExtensionMcpServersView />);
    await screen.findByText("No external MCP servers registered. The built-in Shiba gateway is separate.");
    expect(screen.getAllByRole("button",{name:"Connect with OAuth"})).toHaveLength(6);
    expect(screen.queryByText("GitHub MCP Server")).toBeNull();
    expect(screen.queryByLabelText("Transport")).toBeNull();
    expect(screen.queryByLabelText("Custom header")).toBeNull();
    expect(calls).toContain("/api/v1/mcp/servers");
    expect(calls.some(path=>path.includes("/extensions/mcp-servers"))).toBe(false);
  });
  it("reports authentication failures without claiming saved or connected servers", async () => {
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({error:"Sign in required"},{status:401})));
    render(<ExtensionMcpServersView />);
    await waitFor(()=>expect(screen.getAllByText("Sign in required").length).toBeGreaterThan(0));
    expect(screen.queryByText("GitHub MCP Server")).toBeNull();
    expect(screen.queryByText("OAuth: connected")).toBeNull();
  });
  it("saves a real registry draft and exposes discovery without auto-enabling capabilities", async () => {
    let saved=false;
    const writes:Array<{path:string;body:unknown}>=[];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/v1/mcp/catalog-connections")return Response.json({connections:[]});
      if(path==="/api/agents")return Response.json({principals:[]});
      if(path==="/api/v1/mcp/servers" && init?.method==="POST"){
        writes.push({path,body:JSON.parse(String(init.body))});saved=true;return Response.json({server:{id:"server1"}},{status:201});
      }
      if(path==="/api/v1/mcp/servers")return Response.json({servers:saved?[{id:"server1",name:"Account MCP",endpoint:"https://mcp.example.com/mcp",status:"draft",health:"unknown",tools:[]}]:[]});
      if(path.endsWith("/tools"))return Response.json({tools:[],access:[]});
      if(path.endsWith("/approvals"))return Response.json({approvals:[]});
      return Response.json({error:"Unexpected"},{status:404});
    }));
    render(<ExtensionMcpServersView/>);
    fireEvent.change(screen.getByLabelText("MCP server name"),{target:{value:"Account MCP"}});
    fireEvent.change(screen.getByLabelText("MCP server HTTPS endpoint"),{target:{value:"https://mcp.example.com/mcp"}});
    fireEvent.click(screen.getByRole("button",{name:"Save draft"}));
    await screen.findByText("Account MCP");
    expect(writes).toEqual([{path:"/api/v1/mcp/servers",body:{name:"Account MCP",transport:"streamable_http",url:"https://mcp.example.com/mcp",credentialRef:null}}]);
    expect(screen.getByRole("button",{name:"Discover / retry"})).toBeTruthy();
    expect(writes.some(item=>/enable|grant/.test(item.path))).toBe(false);
  });

  it("renders Overlay breadcrumbs and Add Server header action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [], principals: [], connections: [] })));
    render(<ExtensionMcpServersView scope="workspace" />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.textContent).toContain("Workspace");
    expect(nav.textContent).toContain("Extensions");
    expect(nav.textContent).toContain("MCP Servers");
    expect(screen.getByRole("button", { name: "Add Server" })).toBeTruthy();
  });
});
