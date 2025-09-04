// viewer.js
// This module sets up a simple WebGPU rendering pipeline and draws a rotating cube.

async function initWebGPU() {
  const canvas = document.getElementById('webgpuCanvas');
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

  // Define cube vertices with positions and colors
  const vertexData = new Float32Array([
    // positions         // colors
    // Front face
    -1, -1,  1,         1, 0, 0,
     1, -1,  1,         0, 1, 0,
     1,  1,  1,         0, 0, 1,
    -1,  1,  1,         1, 1, 0,
    // Back face
    -1, -1, -1,         1, 0, 1,
     1, -1, -1,         0, 1, 1,
     1,  1, -1,         1, 1, 1,
    -1,  1, -1,         0.5, 0.5, 0.5,
  ]);
  // Index data defines 12 triangles (two per face)
  const indexData = new Uint16Array([
    0, 1, 2, 0, 2, 3, // front
    1, 5, 6, 1, 6, 2, // right
    5, 4, 7, 5, 7, 6, // back
    4, 0, 3, 4, 3, 7, // left
    3, 2, 6, 3, 6, 7, // top
    4, 5, 1, 4, 1, 0  // bottom
  ]);

  // Create GPU buffers
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  const indexBuffer = device.createBuffer({
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(indexBuffer, 0, indexData);

  // Uniform buffer for MVP matrix
  const uniformBufferSize = 64; // 4x4 matrix (16 floats) * 4 bytes
  const uniformBuffer = device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });

  // Create pipeline
  const shaderModule = device.createShaderModule({
    code: `
struct Uniforms {
  mvpMatrix : mat4x4<f32>;
};
@binding(0) @group(0) var<uniform> uniforms : Uniforms;

struct VertexOut {
  @builtin(position) Position : vec4<f32>;
  @location(0) vColor : vec3<f32>;
};

@vertex
fn vs_main(@location(0) position : vec3<f32>, @location(1) color : vec3<f32>) -> VertexOut {
  var output : VertexOut;
  output.Position = uniforms.mvpMatrix * vec4<f32>(position, 1.0);
  output.vColor = color;
  return output;
}

@fragment
fn fs_main(@location(0) vColor : vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(vColor, 1.0);
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
          arrayStride: 6 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' }
          ]
        }
      ]
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [
        { format: navigator.gpu.getPreferredCanvasFormat() }
      ]
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

  // Depth texture
  let depthTexture = device.createTexture({
    size: [canvas.width, canvas.height, 1],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });

  // Helper functions for matrices
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
    const x0 = eye[0] - center[0];
    const x1 = eye[1] - center[1];
    const x2 = eye[2] - center[2];
    let len = Math.hypot(x0, x1, x2);
    let zx = x0 / len;
    let zy = x1 / len;
    let zz = x2 / len;
    // compute cross(up, z) to get x axis
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz);
    xx /= len; xy /= len; xz /= len;
    // compute y axis as cross(z, x)
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
    for (let i = 0; i < 4; ++i) {
      const ai0 = a[i];
      const ai1 = a[i + 4];
      const ai2 = a[i + 8];
      const ai3 = a[i + 12];
      out[i] = ai0 * b[0] + ai1 * b[1] + ai2 * b[2] + ai3 * b[3];
      out[i + 4] = ai0 * b[4] + ai1 * b[5] + ai2 * b[6] + ai3 * b[7];
      out[i + 8] = ai0 * b[8] + ai1 * b[9] + ai2 * b[10] + ai3 * b[11];
      out[i + 12] = ai0 * b[12] + ai1 * b[13] + ai2 * b[14] + ai3 * b[15];
    }
    return out;
  }
  function rotateY(matrix, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rot = new Float32Array([
      c, 0, -s, 0,
      0, 1,  0, 0,
      s, 0,  c, 0,
      0, 0,  0, 1
    ]);
    return multiply(matrix, rot);
  }

  // Bind group for uniform buffer
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: { buffer: uniformBuffer }
      }
    ]
  });

  // Render loop
  let then = 0;
  function frame(time) {
    const dt = (time - then) / 1000;
    then = time;
    // Update rotation angle based on elapsed time
    const aspect = canvas.width / canvas.height;
    const projection = perspective(Math.PI / 4, aspect, 0.1, 100.0);
    const view = lookAt([3, 3, 4], [0, 0, 0], [0, 1, 0]);
    // Rotate cube over time
    const angle = time * 0.001;
    let model = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    model = rotateY(model, angle);
    // Compute MVP matrix: projection * view * model
    const pv = multiply(projection, view);
    const mvp = multiply(pv, model);
    // Write matrix to uniform buffer
    device.queue.writeBuffer(uniformBuffer, 0, mvp.buffer);

    // Update depth texture if size changed
    if (depthTexture.width !== canvas.width || depthTexture.height !== canvas.height) {
      depthTexture.destroy && depthTexture.destroy();
      depthTexture = device.createTexture({
        size: [canvas.width, canvas.height, 1],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
    }

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();
    const depthView = depthTexture.createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.04, g: 0.09, b: 0.2, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });
    renderPass.setPipeline(pipeline);
    renderPass.setVertexBuffer(0, vertexBuffer);
    renderPass.setIndexBuffer(indexBuffer, 'uint16');
    renderPass.setBindGroup(0, bindGroup);
    renderPass.drawIndexed(indexData.length);
    renderPass.end();
    device.queue.submit([commandEncoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

initWebGPU().catch((err) => {
  console.error(err);
});