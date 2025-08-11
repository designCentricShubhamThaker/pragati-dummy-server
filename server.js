const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.use(cors({
  origin: '*',
  credentials: true
}));

// Helper function to read database
const readDatabase = () => {
  try {
    const data = fs.readFileSync("./db.json", "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading database:", error);
    return { orders: [] };
  }
};

// Helper function to write database
const writeDatabase = (data) => {
  try {
    fs.writeFileSync("./db.json", JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error("Error writing database:", error);
    return false;
  }
};

// Helper function to update stock across all orders for bottles with same name
const updateStockAcrossOrders = (db, bottleName, stockUsed) => {
  db.orders.forEach(order => {
    order.items.forEach(item => {
      if (item.bottle) {
        item.bottle.forEach(bottle => {
          if (bottle.bottle_name === bottleName) {
            bottle.available_stock = Math.max(0, (bottle.available_stock || 0) - stockUsed);
          }
        });
      }
    });
  });
};

// Serve all orders as-is
app.get("/api/orders", (req, res) => {
  const db = readDatabase();
  res.json(db.orders);
});

app.patch("/api/bottles/update-progress", (req, res) => {
  try {
    const { orderNumber, itemId, updates } = req.body;

    if (!orderNumber || !itemId || !updates || !Array.isArray(updates)) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: orderNumber, itemId, and updates array"
      });
    }

    const db = readDatabase();

    // Find the order
    const orderIndex = db.orders.findIndex(order => order.order_number === orderNumber);
    if (orderIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    const order = db.orders[orderIndex];

    // Find the item
    const itemIndex = order.items.findIndex(item => item._id === itemId);
    if (itemIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Item not found in order"
      });
    }

    const item = order.items[itemIndex];
    const currentTime = new Date().toISOString();

    // Process each update
    const processedUpdates = [];

    for (const update of updates) {
      const { deco_no, quantity_produced, stock_used, total_completed, notes } = update;

      // Convert string inputs to numbers
      const numQuantityProduced = parseInt(quantity_produced) || 0;
      const numStockUsed = parseInt(stock_used) || 0;
      const numTotalCompleted = parseInt(total_completed) || 0;

      // Find the bottle in the item
      const bottle = item.bottle.find(b => b.deco_no === deco_no);
      if (!bottle) {
        return res.status(404).json({
          success: false,
          message: `Bottle with deco_no ${deco_no} not found`
        });
      }

      // Validate quantities
      if (numTotalCompleted > bottle.quantity) {
        return res.status(400).json({
          success: false,
          message: `Total completed quantity (${numTotalCompleted}) cannot exceed order quantity (${bottle.quantity}) for ${bottle.bottle_name}`
        });
      }

      // Calculate actual stock usage for this update
      const previousCompleted = bottle.completed_qty || 0;
      const actualQuantityProduced = numQuantityProduced;
      const actualStockUsed = numStockUsed;

      // Validate that completed = produced + stock_used (from this update)
      const expectedCompleted = previousCompleted + actualQuantityProduced + actualStockUsed;
      if (numTotalCompleted !== expectedCompleted) {
        console.warn(`Mismatch in calculations for ${bottle.bottle_name}: 
          Previous: ${previousCompleted}, 
          Produced: ${actualQuantityProduced}, 
          Stock Used: ${actualStockUsed}, 
          Expected: ${expectedCompleted}, 
          Provided: ${numTotalCompleted}`);
      }

      // Update stock across all orders for bottles with same name (only if stock was actually used)
      if (actualStockUsed > 0) {
        updateStockAcrossOrders(db, bottle.bottle_name, actualStockUsed);
      }
      bottle.completed_qty = numTotalCompleted;
      const currentInventoryUsed = parseInt(bottle.inventory_used) || 0;
      bottle.inventory_used = currentInventoryUsed + actualStockUsed;

      if (numTotalCompleted === bottle.quantity) {
        bottle.status = 'Completed';
      } else if (numTotalCompleted > 0) {
        bottle.status = 'In Progress';
      } else {
        bottle.status = 'Pending';
      }

      if (actualQuantityProduced > 0 || actualStockUsed > 0) {
        if (!bottle.tracking_status) {
          bottle.tracking_status = [];
        }

        const trackingEntry = {
          date: currentTime,
          quantity_produced: actualQuantityProduced,
          stock_used: actualStockUsed,
          total_completed: numTotalCompleted,
          notes: notes || '',
          updated_by: 'bottle_team',
          previous_completed: previousCompleted
        };

        bottle.tracking_status.push(trackingEntry);
      }

      processedUpdates.push({
        deco_no,
        bottle_name: bottle.bottle_name,
        previous_completed: previousCompleted,
        new_completed: numTotalCompleted,
        quantity_produced: actualQuantityProduced,
        stock_used: actualStockUsed,
        remaining: bottle.quantity - numTotalCompleted,
        status: bottle.status
      });
    }
    let allItemsCompleted = true;
    let hasInProgress = false;

    for (const orderItem of order.items) {
      if (orderItem.bottle) {
        for (const b of orderItem.bottle) {
          if (b.status === 'Completed') {
            continue;
          } else if (b.status === 'In Progress') {
            hasInProgress = true;
            allItemsCompleted = false;
          } else {
            allItemsCompleted = false;
          }
        }
      }
    }

    if (allItemsCompleted) {
      order.order_status = 'Completed';
    } else if (hasInProgress || order.order_status === 'In Progress') {
      order.order_status = 'In Progress';
    } else {
      order.order_status = 'Pending';
    }
    const saveSuccess = writeDatabase(db);
    if (!saveSuccess) {
      return res.status(500).json({
        success: false,
        message: "Failed to save updates to database"
      });
    }

    res.json({
      success: true,
      message: "Bottle progress updated successfully",
      data: {
        order: order,
        updates: processedUpdates,
        timestamp: currentTime
      }
    });

  } catch (error) {
    console.error("Error updating bottle progress:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});


app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});


app.listen(PORT, () => {
  console.log(`✅ Express server running on http://localhost:${PORT}`);

});