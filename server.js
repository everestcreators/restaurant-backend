const express = require('express');
const axios = require('axios');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// Token cache for Toast API
let cachedToastToken = null;

// ====================  HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend server is running!',
    timestamp: new Date().toISOString()
  });
});

// ====================  AGENT LEVEL WEBHOOK (call events) ====================
app.post('/webhook/retell-events', async (req, res) => {
  const { event, call } = req.body;

  // Only log the event type and call_id — not the full payload
  console.log(`📞 Retell Event: ${event} | call_id: ${call?.call_id}`);

  if (event === 'call_ended') {
    try {
      await db.query(
        `INSERT INTO call_logs (
          call_sid, 
          retell_call_id, 
          from_number, 
          duration,
          transcript,
          success
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          call?.call_id,
          call?.call_id,
          call?.from_number,
          call?.duration_ms ? Math.round(call.duration_ms / 1000) : null,
          call?.transcript || null,
          true
        ]
      );
      console.log('✅ Call log saved');
    } catch (err) {
      console.error('❌ Failed to save call log:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

// ====================  MAIN WEBHOOK HANDLER (function calls) ====================
app.post('/webhook/retell-function', async (req, res) => {
  console.log('🔔 Received order webhook from Retell AI');

  // Retell sends arguments directly in body
  const functionArgs = req.body;
  const call_id = functionArgs.call_id || 'unknown_' + Date.now();

  // Log only the important parts
  console.log(`👤 Customer: ${functionArgs.customer_name} | Items: ${functionArgs.items?.length}`);

  try {
    console.log('🛒 Processing order...');
    const result = await processOrder(functionArgs);

    console.log('✅ Order processed successfully');
    res.json({ result: result.message });

  } catch (error) {
    console.error('❌ Error processing order:', error.message);
    await logError(call_id, error);
    res.json({
      error: 'Sorry, there was an issue processing your order. Let me transfer you to our staff.'
    });
  }
});

// ====================  PROCESS ORDER ====================
async function processOrder(orderData) {
  console.log('Step 1: Validating order...');
  const validatedOrder = await validateOrder(orderData);

  console.log('Step 2: Sending to Toast POS...');
  const toastResponse = await sendToToast(validatedOrder);

  console.log('Step 3: Saving to database...');
  await saveToDatabase(validatedOrder, toastResponse);

  console.log('Step 4: Building confirmation message...');
  const message = buildConfirmationMessage(validatedOrder, toastResponse);

  return { message };
}

// ====================  VALIDATE ORDER ====================
async function validateOrder(orderData) {
  console.log('Validating items against menu...');

  const itemIds = orderData.items.map(item => item.item_id);
  const menuQuery = `
    SELECT toast_item_id, name, price, modifiers
    FROM menu_items
    WHERE toast_item_id = ANY($1::text[])
  `;

  const menuResult = await db.query(menuQuery, [itemIds]);
  const menuItems = menuResult.rows;

  console.log(`Found ${menuItems.length} menu items`);

  const enrichedItems = [];
  let subtotal = 0;

  for (const item of orderData.items) {
    const menuItem = menuItems.find(m => m.toast_item_id === item.item_id);

    if (!menuItem) {
      throw new Error(`Item not found in menu: ${item.item_id}`);
    }

    let itemTotal = menuItem.price * item.quantity;

    const enrichedModifiers = [];
    if (item.modifiers && item.modifiers.length > 0) {
      for (const mod of item.modifiers) {
        const menuModifiers = menuItem.modifiers || [];
        const menuModifier = menuModifiers.find(m => m.id === mod.modifier_id);

        if (!menuModifier) {
          console.warn(`Modifier not found: ${mod.modifier_id}, skipping...`);
          continue;
        }

        enrichedModifiers.push({
          modifier_id: mod.modifier_id,
          name: menuModifier.name,
          price: menuModifier.price,
          action: mod.action || 'add'
        });

        if ((mod.action || 'add') === 'add') {
          itemTotal += menuModifier.price * item.quantity;
        }
      }
    }

    enrichedItems.push({
      item_id: item.item_id,
      name: menuItem.name,
      quantity: item.quantity,
      base_price: menuItem.price,
      modifiers: enrichedModifiers,
      item_total: itemTotal
    });

    subtotal += itemTotal;
  }

  const tax = subtotal * 0.08;
  const total = subtotal + tax;

  console.log(`Order validated: Subtotal $${subtotal.toFixed(2)}, Total $${total.toFixed(2)}`);

  return {
    ...orderData,
    items: enrichedItems,
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax: parseFloat(tax.toFixed(2)),
    total: parseFloat(total.toFixed(2)),
    validated: true
  };
}

// ====================  TOAST API ====================
async function getToastToken() {
  if (cachedToastToken && cachedToastToken.expiresAt > Date.now()) {
    return cachedToastToken.token;
  }

  const token = process.env.TOAST_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Toast API token not configured');
  }

  return token;
}

function formatOrderForToast(validatedOrder) {
  return {
    checks: [{
      selections: validatedOrder.items.map(item => ({
        itemId: item.item_id,
        quantity: item.quantity,
        modifiers: item.modifiers.map(mod => ({
          modifierId: mod.modifier_id,
          quantity: mod.action === 'add' ? 1 : -1
        }))
      }))
    }],
    serviceArea: 'TAKEOUT'
  };
}

async function sendToToast(validatedOrder) {
  const toastOrder = formatOrderForToast(validatedOrder);

  if (!process.env.TOAST_ACCESS_TOKEN || !process.env.TOAST_RESTAURANT_GUID) {
    console.log('⚠️  Toast not configured, simulating response...');
    return {
      order_id: 'test_order_' + Date.now(),
      pickup_time: 20,
      pickup_timestamp: new Date(Date.now() + 20 * 60000).toISOString()
    };
  }

  const token = await getToastToken();

  try {
    const response = await axios.post(
      'https://ws-api.toasttab.com/orders/v2/orders',
      toastOrder,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Toast-Restaurant-External-ID': process.env.TOAST_RESTAURANT_GUID,
          'Content-Type': 'application/json'
        }
      }
    );

    const pickupTime = new Date();
    pickupTime.setMinutes(pickupTime.getMinutes() + 20);

    return {
      order_id: response.data.guid,
      pickup_time: 20,
      pickup_timestamp: pickupTime.toISOString()
    };

  } catch (error) {
    console.error('Toast API Error:', error.response?.data || error.message);
    throw new Error('Failed to create order in Toast POS');
  }
}

// ====================  DATABASE ====================
async function saveToDatabase(validatedOrder, toastResponse) {
  try {
    const orderId = await saveOrder(validatedOrder, toastResponse);
    await saveOrderItems(orderId, validatedOrder.items);
    await logCall(validatedOrder.call_id, {
      ...validatedOrder,
      order_id: orderId
    }, true);

    console.log(`✅ Order ${orderId} saved to database`);

  } catch (error) {
    console.error('Database save error:', error.message);
  }
}

async function saveOrder(orderData, toastResponse) {
  const query = `
    INSERT INTO orders (
      call_id, toast_order_id, customer_name, customer_phone,
      subtotal, tax, total, status, estimated_pickup_time
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `;

  const values = [
    orderData.call_id,
    toastResponse.order_id,
    orderData.customer_name,
    orderData.customer_phone || null,
    orderData.subtotal,
    orderData.tax,
    orderData.total,
    'confirmed',
    toastResponse.pickup_timestamp
  ];

  const result = await db.query(query, values);
  return result.rows[0].id;
}

async function saveOrderItems(orderId, items) {
  for (const item of items) {
    const itemQuery = `
      INSERT INTO order_items (
        order_id, item_id, item_name, quantity,
        base_price, item_total
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;

    const itemValues = [
      orderId,
      item.item_id,
      item.name,
      item.quantity,
      item.base_price,
      item.item_total
    ];

    const itemResult = await db.query(itemQuery, itemValues);
    const itemId = itemResult.rows[0].id;

    if (item.modifiers && item.modifiers.length > 0) {
      await saveModifiers(itemId, item.modifiers);
    }
  }
}

async function saveModifiers(orderItemId, modifiers) {
  for (const mod of modifiers) {
    const query = `
      INSERT INTO order_modifiers (
        order_item_id, modifier_id, modifier_name,
        price, action
      )
      VALUES ($1, $2, $3, $4, $5)
    `;

    await db.query(query, [
      orderItemId,
      mod.modifier_id,
      mod.name,
      mod.price,
      mod.action
    ]);
  }
}

async function logCall(callId, orderData, success, error = null) {
  const query = `
    INSERT INTO call_logs (
      call_sid, retell_call_id, from_number,
      order_id, success, error_message
    )
    VALUES ($1, $2, $3, $4, $5, $6)
  `;

  try {
    await db.query(query, [
      callId,
      orderData.call_id,
      orderData.customer_phone,
      orderData.order_id,
      success,
      error
    ]);
  } catch (err) {
    console.error('Failed to log call:', err.message);
  }
}

async function logError(callId, error) {
  const query = `
    INSERT INTO error_logs (
      call_id, error_type, error_message, stack_trace
    )
    VALUES ($1, $2, $3, $4)
  `;

  try {
    await db.query(query, [
      callId,
      error.name || 'Error',
      error.message,
      error.stack
    ]);
  } catch (err) {
    console.error('Failed to log error:', err.message);
  }
}

// ====================  CONFIRMATION MESSAGE ====================
function buildConfirmationMessage(validatedOrder, toastResponse) {
  const customerName = validatedOrder.customer_name || 'there';
  const total = validatedOrder.total.toFixed(2);
  const pickupTime = toastResponse.pickup_time;

  return `Perfect! Your order is confirmed for ${customerName}. ` +
    `Total is $${total}. ` +
    `It'll be ready in ${pickupTime} minutes for pickup at 123 Main Street.`;
}

// ====================  ERROR HANDLERS ====================
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err.message);
});

// ====================  START SERVER ====================
app.listen(PORT, () => {
  console.log('🚀 Backend server started!');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🔔 Function webhook: http://localhost:${PORT}/webhook/retell-function`);
  console.log(`📞 Events webhook:   http://localhost:${PORT}/webhook/retell-events`);
  console.log(`❤️  Health check:    http://localhost:${PORT}/health`);
  console.log('⏳ Waiting for orders...');
});