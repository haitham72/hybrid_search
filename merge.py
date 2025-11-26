import pandas as pd
import json
import ast

def parse_list_column(value):
    """Parse a column value that might be a list, string representation of list, or empty"""
    if pd.isna(value) or value == '' or value == '---':
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            # Try to parse as JSON/Python list
            parsed = ast.literal_eval(value)
            if isinstance(parsed, list):
                return parsed
            return [parsed]
        except:
            # If parsing fails, treat as single item
            return [value] if value.strip() else []
    return []

def merge_list_columns(main_val, *other_vals):
    """Merge multiple list columns, removing duplicates while preserving order"""
    result = []
    seen = set()
    
    # Start with main value
    for item in parse_list_column(main_val):
        item_str = str(item).strip()
        if item_str and item_str not in seen:
            result.append(item)
            seen.add(item_str)
    
    # Add from other columns
    for val in other_vals:
        for item in parse_list_column(val):
            item_str = str(item).strip()
            if item_str and item_str not in seen:
                result.append(item)
                seen.add(item_str)
    
    return result if result else []

def merge_sentiment_columns(main_val, *other_vals):
    """Merge sentiment columns, treating them as comma-separated strings"""
    result = []
    seen = set()
    
    all_vals = [main_val] + list(other_vals)
    for val in all_vals:
        if pd.isna(val) or val == '' or val == 'neutral':
            continue
        # Split by comma and clean
        items = [item.strip() for item in str(val).split(',')]
        for item in items:
            if item and item != 'neutral' and item not in seen:
                result.append(item)
                seen.add(item)
    
    return ', '.join(result) if result else ''

# Read the three separate Excel files
main_df = pd.read_excel('main.xlsx')
sheet1_df = pd.read_excel('Sheet1.xlsx')
sheet2_df = pd.read_excel('Sheet2.xlsx')

# Create output dataframe starting with main
output_df = main_df.copy()

# Process each row by row number (index)
for idx in range(len(output_df)):
    # Get corresponding rows from enrichment tables (matching by row position)
    sheet1_row = sheet1_df.iloc[idx] if idx < len(sheet1_df) else None
    sheet2_row = sheet2_df.iloc[idx] if idx < len(sheet2_df) else None
    
    # Merge 'people' columns
    people_cols = []
    if sheet1_row is not None:
        people_cols.extend([sheet1_row.get('people'), sheet1_row.get('people_02')])
    if sheet2_row is not None:
        people_cols.extend([sheet2_row.get('people'), sheet2_row.get('people_02')])
    output_df.at[idx, 'people'] = merge_list_columns(output_df.at[idx, 'people'], *people_cols)
    
    # Merge 'places' columns
    places_cols = []
    if sheet1_row is not None:
        places_cols.extend([sheet1_row.get('places'), sheet1_row.get('places_02')])
    if sheet2_row is not None:
        places_cols.extend([sheet2_row.get('places'), sheet2_row.get('places_02')])
    output_df.at[idx, 'places'] = merge_list_columns(output_df.at[idx, 'places'], *places_cols)
    
    # Merge 'sentiments' columns
    sentiments_cols = []
    if sheet1_row is not None:
        sentiments_cols.extend([sheet1_row.get('Sentiments'), sheet1_row.get('Sentiments_02')])
    if sheet2_row is not None:
        sentiments_cols.extend([sheet2_row.get('Sentiments'), sheet2_row.get('Sentiments_02')])
    output_df.at[idx, 'sentiments'] = merge_sentiment_columns(output_df.at[idx, 'sentiments'], *sentiments_cols)
    
    # Merge 'objects' columns (checking for original_objects, objects, objects_02, objects_03, objects_04, objects_05)
    objects_cols = []
    if sheet1_row is not None:
        for col in ['original_objects', 'objects', 'objects_02', 'objects_03', 'objects_04', 'objects_05']:
            if col in sheet1_row:
                objects_cols.append(sheet1_row.get(col))
    if sheet2_row is not None:
        for col in ['objects', 'objects_02', 'objects_03', 'objects_04', 'objects_05']:
            if col in sheet2_row:
                objects_cols.append(sheet2_row.get(col))
    output_df.at[idx, 'objects'] = merge_list_columns(output_df.at[idx, 'objects'], *objects_cols)
    

df = output_df

# Now you can do data science on it
print(df.head())
print(df.info())
print(df.columns)

# Save to Excel
output_df.to_excel('poems_merged_output.xlsx', index=False, engine='openpyxl')
print("Merge complete! Output saved to 'poems_merged_output.xlsx'")
print(f"Processed {len(output_df)} rows")






# Display sample of merged data
print("\nSample of merged data:")
for idx in range(min(3, len(output_df))):
    print(f"\nRow {idx + 1}:")
    print(f"  People: {output_df.at[idx, 'people']}")
    print(f"  Places: {output_df.at[idx, 'places']}")
    print(f"  Sentiments: {output_df.at[idx, 'sentiments']}")
    print(f"  Objects: {output_df.at[idx, 'objects']}")
    
