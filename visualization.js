// visualization.js
// This module implements a simple real‑time 3D bar chart using WebGPU.
// The chart attempts to fetch external data (cryptocurrency prices) from a public
// API.  If the network request fails, it falls back to random data.  Bars are
// rendered as instanced cubes with individual heights.

async function initVisualization() {
  const canvas = document.getElementById('vizCanvas');
  if (!navigator.gpu) {
    document.getElementById('message').style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');

  const devicePixelRatio = window.devicePixelRatio || 1;
  function resizeCanvas() {
    const width = canvas.clientWidth * devicePixelRatio;
    const height = canvas.clientHeight * devicePixelRatio;
    canvas.width = width;
    canvas.height = height;
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'opaque',
      size: [width, height]
    });
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Define cube geometry (unit cube centered at origin)
  const cubeVertices = new Float32Array([
    // positions
    -0.5, -0.5,  0.5,
     0.5, -0.5,  0.5,
     0.5,  0.5,  0.5,
    -0.5,  0.5,  0.5,
    -0.5, -0.5, -0.5,
     0.5, -0.5, -0.5,
     0.5,  0.5, -0.5,
    -0.5,  0.5, -0.5,
  ]);
  const cubeIndices = new Uint16Array([
    0, 1, 2, 0, 2, 3,
    1, 5, 6, 1, 6, 2,
    5, 4, 7, 5, 7, 6,
    4, 0, 3, 4, 3, 7,
    3, 2, 6, 3, 6, 7,
    4, 5, 1, 4, 1, 0,
  ]);
  const vertexBuffer = device.createBuffer({
    size: cubeVertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(vertexBuffer, 0, cubeVertices);
  const indexBuffer = device.createBuffer({
    size: cubeIndices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(indexBuffer, 0, cubeIndices);

  // Set number of bars and spacing
  const barCount = 10;
  const barSpacing = 0.12;
  // Initial instance data: offsets and scales (y scale will be updated)
  let instanceData = new Float32Array(barCount * 6); // offset.xyz + scale.xyz
  for (let i = 0; i < barCount; i++) {
    const x = (i - (barCount - 1) / 2) * barSpacing;
    // offsets: x, y, z
    instanceData[i * 6 + 0] = x;
    instanceData[i * 6 + 1] = 0.0;
    instanceData[i * 6 + 2] = 0.0;
    // scales: x, y, z (x and z scales remain constant)
    instanceData[i * 6 + 3] = 0.08;
    instanceData[i * 6 + 4] = 0.5; // initial height (will be replaced)
    instanceData[i * 6 + 5] = 0.08;
  }
  const instanceBuffer = device.createBuffer({
    size: instanceData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(instanceBuffer, 0, instanceData);

  // Uniform buffer for MVP matrix
  const uniformBufferSize = 64;
  const uniformBuffer = device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // Shader code for instanced bar chart
  const shaderModule = device.createShaderModule({
    code: `
struct Uniforms {
  mvpMatrix : mat4x4<f32>;
};
@binding(0) @group(0) var<uniform> uniforms : Uniforms;

struct VertexInput {
  @location(0) position : vec3<f32>;
  @location(1) offset : vec3<f32>;
  @location(2) scale : vec3<f32>;
};

struct VertexOutput {
  @builtin(position) Position : vec4<f32>;
  @location(0) vColor : vec3<f32>;
};

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  // apply scale and offset to cube vertices
  let worldPos = input.position * input.scale + input.offset;
  out.Position = uniforms.mvpMatrix * vec4<f32>(worldPos, 1.0);
  // color based on height (y scale)
  let intensity = clamp(input.scale.y * 2.0, 0.0, 1.0);
  out.vColor = vec3<f32>(0.2 + 0.6 * intensity, 0.4, 1.0 - intensity);
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.vColor, 1.0);
}
`
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 3 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }
          ]
        },
        {
          arrayStride: 6 * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 1, offset: 0, format: 'float32x3' },
            { shaderLocation: 2, offset: 3 * 4, format: 'float32x3' }
          ]
        }
      ]
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [ { format: navigator.gpu.getPreferredCanvasFormat() } ]
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'back'
    },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: 'depth24plus'
    }
  });

  let depthTexture = device.createTexture({
    size: [canvas.width, canvas.height, 1],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });

  // Matrix helper functions (same as viewer.js)
  function perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[14] = 2 * far * near * nf;
    out[15] = 0;
    return out;
  }
  function lookAt(eye, center, up) {
    const out = new Float32Array(16);
    const zx0 = eye[0] - center[0];
    const zx1 = eye[1] - center[1];
    const zx2 = eye[2] - center[2];
    let len = Math.hypot(zx0, zx1, zx2);
    let zx = zx0 / len;
    let zy = zx1 / len;
    let zz = zx2 / len;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz);
    xx /= len; xy /= len; xz /= len;
    let yx = zy * xz - zz * xy;
    let yy = zz * xx - zx * xz;
    let yz = zx * xy - zy * xx;
    len = Math.hypot(yx, yy, yz);
    yx /= len; yy /= len; yz /= len;
    out[0] = xx;
    out[1] = yx;
    out[2] = zx;
    out[3] = 0;
    out[4] = xy;
    out[5] = yy;
    out[6] = zy;
    out[7] = 0;
    out[8] = xz;
    out[9] = yz;
    out[10] = zz;
    out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }
  function multiply(a, b) {
    const out = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = b[0], b01 = b[1], b02 = b[2], b03 = b[3];
    const b10 = b[4], b11 = b[5], b12 = b[6], b13 = b[7];
    const b20 = b[8], b21 = b[9], b22 = b[10], b23 = b[11];
    const b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15];
    out[0] = a00 * b00 + a01 * b10 + a02 * b20 + a03 * b30;
    out[1] = a00 * b01 + a01 * b11 + a02 * b21 + a03 * b31;
    out[2] = a00 * b02 + a01 * b12 + a02 * b22 + a03 * b32;
    out[3] = a00 * b03 + a01 * b13 + a02 * b23 + a03 * b33;
    out[4] = a10 * b00 + a11 * b10 + a12 * b20 + a13 * b30;
    out[5] = a10 * b01 + a11 * b11 + a12 * b21 + a13 * b31;
    out[6] = a10 * b02 + a11 * b12 + a12 * b22 + a13 * b32;
    out[7] = a10 * b03 + a11 * b13 + a12 * b23 + a13 * b33;
    out[8] = a20 * b00 + a21 * b10 + a22 * b20 + a23 * b30;
    out[9] = a20 * b01 + a21 * b11 + a22 * b21 + a23 * b31;
    out[10] = a20 * b02 + a21 * b12 + a22 * b22 + a23 * b32;
    out[11] = a20 * b03 + a21 * b13 + a22 * b23 + a23 * b33;
    out[12] = a30 * b00 + a31 * b10 + a32 * b20 + a33 * b30;
    out[13] = a30 * b01 + a31 * b11 + a32 * b21 + a33 * b31;
    out[14] = a30 * b02 + a31 * b12 + a32 * b22 + a33 * b32;
    out[15] = a30 * b03 + a31 * b13 + a32 * b23 + a33 * b33;
    return out;
  }

  // Function to update instance scales based on data array
  function updateInstanceScales(values) {
    const maxValue = Math.max(...values, 1);
    for (let i = 0; i < barCount; i++) {
      const normalized = values[i] / maxValue;
      // update y-scale
      instanceData[i * 6 + 4] = 0.05 + normalized * 0.9;
    }
    device.queue.writeBuffer(instanceBuffer, 0, instanceData);
  }

  // Fetch external data (cryptocurrency prices) and update chart
  async function fetchDataAndUpdate() {
    try {
      const resp = await fetch('https://api.coindesk.com/v1/bpi/currentprice.json');
      if (resp.ok) {
        const data = await resp.json();
        const usdRate = parseFloat(data.bpi?.USD?.rate?.replace(/,/g, '')) || Math.random() * 50000;
        // generate 10 values around the rate with some noise
        const values = new Array(barCount).fill(0).map(() => usdRate * (0.8 + Math.random() * 0.4));
        updateInstanceScales(values);
        return;
      }
    } catch (e) {
      // ignore network errors
    }
    // fallback to random values
    const randomValues = new Array(barCount).fill(0).map(() => Math.random() * 100);
    updateInstanceScales(randomValues);
  }

  // Periodically fetch data
  setInterval(fetchDataAndUpdate, 15000);
  // Initial fetch
  fetchDataAndUpdate();

  // Render loop
  let rotation = 0;
  function frame() {
    rotation += 0.003;
    const aspect = canvas.width / canvas.height;
    const proj = perspective(Math.PI / 4, aspect, 0.1, 100);
    // orbit the camera around the origin
    const radius = 3.0;
    const eye = [Math.sin(rotation) * radius, 2.0, Math.cos(rotation) * radius];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const mvp = multiply(proj, view);
    device.queue.writeBuffer(uniformBuffer, 0, mvp.buffer);

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.02, g: 0.04, b: 0.08, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store'
      }
    });
    renderPass.setPipeline(pipeline);
    renderPass.setVertexBuffer(0, vertexBuffer);
    renderPass.setVertexBuffer(1, instanceBuffer);
    renderPass.setIndexBuffer(indexBuffer, 'uint16');
    renderPass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [ { binding: 0, resource: { buffer: uniformBuffer } } ]
    }));
    renderPass.drawIndexed(cubeIndices.length, barCount);
    renderPass.end();
    device.queue.submit([commandEncoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

initVisualization().catch(console.error);
